/**
 * recorder-core.js — 与 DOM 无关的分段录制核心。
 *
 * 设计要点（对应需求）：
 *  1. 主 / 备两个设备，每个设备上的连续媒体只属于一个“片段(segment)”。
 *  2. 主设备断开、轨道 ended、轨道静音(mute)、权限失效：当前片段立即明确结束，
 *     段与段之间记录“时间缺口(gap)”；若备设备可用，从【新片段】继续，
 *     绝不在时间清单里把两段伪装成无中断的单一视频。
 *  3. 所有改变状态的操作（开始 / 手动切换 / 自动接管 / 停止 / 热插拔）经同一个
 *     串行队列 enqueue()，因此与 MediaRecorder 的异步 ondataavailable / onstop
 *     回调交错时也有确定的归属：
 *       - 片段进入 sealed 后，任何迟到块一律丢弃（只归属原片段，停止后不追加）；
 *       - stop() 之后不会再因迟到回调产生新片段或新数据。
 *  4. heldBytes 预算：限制页面持有的媒体大小，超限自动停止并通知 UI 提示。
 *  5. createObjectURL / revokeObjectURL 走注入的 URL 对象，便于测试并保证
 *     撤销已不再使用的 URL。
 *  6. 媒体始终只在本机（Blob / ObjectURL），不发起任何网络上传。
 */

const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4'
];

/**
 * 统一的自定义事件：浏览器直接用 CustomEvent；Node 测试环境里全局 CustomEvent
 * 对 detail 的处理不一致，这里提供等价回退。
 */
function makeEvent(type, detail) {
  try {
    return new CustomEvent(type, { detail });
  } catch {
    return { type, detail };
  }
}

/** 在注入或原生 MediaRecorder 支持的类型中挑一个容器/编码。 */
export function pickSupportedMimeType(MR) {
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  for (const t of VIDEO_MIME_CANDIDATES) {
    try {
      if (MR.isTypeSupported(t)) return t;
    } catch {
      /* 某些实现对个别字符串抛异常，忽略并继续 */
    }
  }
  return '';
}

/**
 * @typedef {Object} Segment
 * @property {number} index          从 0 开始的片段序号
 * @property {string} deviceId       采集该片段的设备
 * @property {'primary'|'backup'} role  采集时设备承担的角色
 * @property {string} label          设备标签（清单用）
 * @property {'recording'|'sealing'|'sealed'|'error'} state
 * @property {number} startedAt      Date.now() 采集起点（墙钟）
 * @property {number|null} endedAt   Date.now() 采集终点（墙钟）
 * @property {number} startPerf      performance.now() 单调时钟，用于时长
 * @property {number|null} endPerf
 * @property {Blob|null} blob        成品 Blob（sealed 后）
 * @property {string|null} url       ObjectURL（sealed 后）
 * @property {number} bytes          该段字节数
 * @property {string} reason         结束原因
 * @property {Array<Blob|ArrayBuffer>} chunks  收到的块
 * @property {MediaStream} [stream]  原始流（stop 后不再使用）
 */

/**
 * @typedef {Object} Gap
 * @property {number} afterSegment 缺口前的片段 index
 * @property {number} from        缺口起点（墙钟，ms）
 * @property {number|null} to     缺口终点；null 表示录制结束时仍未恢复
 * @property {string} reason      disconnect | mute | permission | switch | failover-failed
 */

export class Recorder extends EventTarget {
  /**
   * @param {Object} cfg
   * @param {MediaDevices} cfg.mediaDevices
   * @param {typeof MediaRecorder} cfg.MediaRecorder
   * @param {URL*} cfg.urlObj       具备 createObjectURL/revokeObjectURL
   * @param {{primaryId:string, backupId:string}} cfg.devices
   * @param {number} [cfg.maxHeldBytes] 媒体持有量预算
   * @param {number} [cfg.timeslice]   dataavailable 推送间隔
   * @param {number} [cfg.stopTimeoutMs] onstop 迟到上限，超时强制封口
   * @param {{now:()=>number, set, clear}} [cfg.clock] 可注入时钟/定时器
   * @param {boolean} [cfg.audio]   是否同时请求麦克风
   * @param {boolean} [cfg.watchPermission]
   * @param {boolean} [cfg.watchDeviceChanges]
   */
  constructor(cfg) {
    super();
    this.mediaDevices = cfg.mediaDevices;
    this.MediaRecorder = cfg.MediaRecorder;
    this.urlObj = cfg.urlObj;
    this.primaryId = cfg.devices.primaryId;
    this.backupId = cfg.devices.backupId;
    this.maxHeldBytes = cfg.maxHeldBytes ?? 512 * 1024 * 1024;
    this.timeslice = cfg.timeslice ?? 1000;
    this.stopTimeoutMs = cfg.stopTimeoutMs ?? 15000;
    this.audio = cfg.audio ?? false;
    const clock = cfg.clock || {};
    this._now = clock.now
      ? () => clock.now()
      : () => Date.now();
    this._setTimeout =
      clock.setTimeout ||
      ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = clock.clearTimeout || ((id) => clearTimeout(id));
    this.mimeType = pickSupportedMimeType(this.MediaRecorder);

    /** @type {Segment[]} */
    this.segments = [];
    /** @type {Gap[]} */
    this.gaps = [];

    this.running = false;
    /** @type {Segment|null} */
    this.active = null;
    this.activeDeviceId = null;
    this.activeRole = null;
    this.heldBytes = 0;
    this.quotaExceeded = false;

    this._recorder = null;
    this._stopTimer = null;
    this._sealingCount = 0;
    this._whenSettledResolvers = [];
    this._lastError = null;
    this._disposed = false;
    this._deviceList = [];
    /** 每次停止/释放递增；用于作废 await getUserMedia 期间迟到的流。 */
    this._epoch = 0;
    /** stop() 同步置位：即使停止任务还排在队列后面，在途采集也必须作废。 */
    this._stopRequested = false;

    // 串行化所有状态迁移，杜绝手动操作与异步回调交错造成的竞争。
    this._chain = Promise.resolve();

    if (cfg.watchPermission !== false) this._watchPermission();
    if (cfg.watchDeviceChanges !== false) this._watchDeviceChanges();
  }

  // ------------------------------------------------------------------ 工具

  /** 串行执行；任务内 await 期间不会有第二个任务穿插修改状态。 */
  enqueue(task, name = 'task') {
    const run = this._chain.then(() => {
      if (this._disposed) return undefined;
      return task();
    });
    // 不让单个任务的异常打断整条链
    this._chain = run.then(
      () => undefined,
      (err) => {
        // 任务自身没接住的错误：通知 UI，但链继续
        this._emit('internalerror', { error: err, where: name });
      }
    );
    return run;
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(makeEvent(type, detail));
  }

  _deviceLabel(id) {
    const d = this._deviceList.find((x) => x.deviceId === id);
    return d?.label || id || 'unknown-device';
  }

  /** 由 UI 在 enumerateDevices 后同步，供清单写出可读设备名。 */
  setDeviceList(list) {
    this._deviceList = Array.isArray(list) ? list : [];
  }

  _constraintsFor(deviceId) {
    const constraints = {
      video: { deviceId: { exact: deviceId } },
      audio: this.audio ? { deviceId: { exact: deviceId } } : false
    };
    return constraints;
  }

  /** 设备此刻是否仍枚举在内；enumerateDevices 不可用时视为可用。 */
  _isPresent(deviceId) {
    if (!this._deviceList.length) return true;
    return this._deviceList.some((d) => d.deviceId === deviceId);
  }

  // ------------------------------------------------------------------ 生命周期

  /** 开始（或异常结束后的重新开始，会另起一组片段/缺口）。 */
  start(preferRole = 'primary') {
    return this.enqueue(() => this._start(preferRole), 'start');
  }

  async _start(preferRole) {
    if (this.running) return;
    // 新的录制会话：清掉上一会话遗留的片段（撤销其 URL）。
    for (const s of this.segments) this._revokeUrl(s);
    this.segments = [];
    this.gaps = [];
    this.heldBytes = 0;
    this.quotaExceeded = false;
    this._lastError = null;
    this._stopRequested = false;
    this.running = true; // 先置位，await getUserMedia 期间的事件才被视为有效

    const firstId =
      preferRole === 'backup' ? this.backupId : this.primaryId;
    await this._beginSegment(firstId, preferRole, 'start', null);
    // 采集 await 期间用户已停止：本任务不再兜底，running 由停止路径复位。
    if (this._stopRequested && this.running) {
      this.running = false;
    }
  }

  /** 手动切换：当前片段明确结束 + 记录 switch 缺口 + 新片段继续。 */
  switchTo(roleOrId) {
    return this.enqueue(() => this._switchTo(roleOrId), 'switchTo');
  }

  async _switchTo(roleOrId) {
    if (!this.running) throw new Error('recorder is not running');
    const role = roleOrId === 'backup' || roleOrId === 'primary'
      ? roleOrId
      : null;
    const targetId = role
      ? role === 'backup' ? this.backupId : this.primaryId
      : roleOrId;
    if (targetId === this.activeDeviceId) return;

    const prev = this.active;
    await this._sealCurrent('manual-switch');
    const gap = {
      afterSegment: prev ? prev.index : -1,
      from: prev?.endedAt ?? this._now(),
      to: null,
      reason: 'switch'
    };
    this.gaps.push(gap);
    await this._beginSegment(targetId, role, 'manual-switch', {
      gap,
      failedId: prev ? prev.deviceId : null
    });
  }

  /**
   * 用户停止：封口，不产生缺口（这是干净结束，不是中断）。
   * 停止意图在【调用瞬间】同步生效（纪元 +1），保证排在队列后面的停止任务
   * 执行前，任何在途 getUserMedia 回来都会发现自己已作废；封口动作仍经队列串行。
   */
  stop() {
    this._stopRequested = true;
    if (this.running) this._epoch++;
    return this.enqueue(() => this._stop(), 'stop');
  }

  async _stop() {
    if (!this.running) return;
    this.running = false;
    this._epoch++;
    // 停止任务入队前可能恰好有接管任务完成：active 非空也要封口，
    // 绝不让“停止后新建的片段”继续录。
    await this._sealCurrent('user-stop');
  }

  /** 停止后等待全部异步封口（onstop / 超时强制封口）落定。 */
  whenSettled() {
    if (this._sealingCount === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this._whenSettledResolvers.push(resolve);
    });
  }

  _settleIfDone() {
    if (this.running || this._sealingCount !== 0) return;
    const resolvers = this._whenSettledResolvers.splice(0);
    for (const r of resolvers) r();
    this._emit('settled', {
      segments: this.segments.slice(),
      gaps: this.gaps.slice()
    });
  }

  /** 释放全部资源（停止录制、撤销所有 URL、解除监听）。 */
  async dispose() {
    await this.enqueue(async () => {
      this.running = false;
      this._epoch++;
      await this._sealCurrent('dispose');
      // 不再使用的 ObjectURL 一律撤销；活动/封口中段的流轨道全部停止。
      for (const s of this.segments) {
        this._revokeUrl(s);
        if (s.stream) {
          for (const t of s.stream.getTracks()) {
            try { t.stop(); } catch { /* ignore */ }
          }
          this._unbindTracks(s);
        }
      }
      if (this._permStatus && this._permOnChange) {
        this._permStatus.removeEventListener?.('change', this._permOnChange);
      }
      if (this._deviceChangeHandler && this.mediaDevices?.removeEventListener) {
        this.mediaDevices.removeEventListener(
          'devicechange',
          this._deviceChangeHandler
        );
      }
      this.heldBytes = 0;
    }, 'dispose');
    this._disposed = true;
    this.segments = [];
    this.gaps = [];
    this.active = null;
  }

  // ------------------------------------------------------------------ 片段

  /**
   * 在指定设备上开启一个【新片段】。
   * @param {string} deviceId
   * @param {'primary'|'backup'|null} roleHint
   * @param {string} trigger  start | manual-switch | disconnect | mute | ended | permission
   * @param {{gap:Gap, failedId:string}|null} closure  若由接管触发，携带待闭合缺口
   */
  async _beginSegment(deviceId, roleHint, trigger, closure) {
    const epoch = this._epoch;
    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia(
        this._constraintsFor(deviceId)
      );
    } catch (err) {
      // 拿不到目标设备：手动切换时尝试另一台；中断接管时交给 _failover 决策。
      if (trigger === 'manual-switch') {
        this._emit('switchfailed', {
          requestedId: deviceId,
          error: err.name || String(err)
        });
        // 切换发生时活动段已经封口；排除【打不开的目标】，让 failover 选另一台。
        await this._failover('manual-switch', closure, [deviceId]);
        return;
      }
      this._acquireFailed(deviceId, trigger, err, closure);
      return;
    }

    // await getUserMedia 期间用户可能已经停止录制（纪元变化）：立刻释放迟到的流。
    if (!this.running || epoch !== this._epoch) {
      for (const t of stream.getTracks()) t.stop();
      if (closure?.gap && closure.gap.to == null) {
        closure.gap.failoverFailed = true;
      }
      this._settleIfDone();
      return;
    }

    const role =
      roleHint || (deviceId === this.primaryId ? 'primary' : 'backup');
    const segment = {
      index: this.segments.length,
      deviceId,
      role,
      label: this._deviceLabel(deviceId),
      state: 'recording',
      startedAt: this._now(),
      endedAt: null,
      startPerf: this._now(),
      endPerf: null,
      blob: null,
      url: null,
      bytes: 0,
      reason: '',
      chunks: [],
      stream
    };
    this.segments.push(segment);
    this.active = segment;
    this.activeDeviceId = deviceId;
    this.activeRole = role;
    this.running = true;

    // 闭合该片段之前的缺口（新片段开始 = 缺口结束）。
    if (closure?.gap && closure.gap.to == null) {
      closure.gap.to = segment.startedAt;
    }

    let recorder;
    try {
      recorder = new this.MediaRecorder(stream, {
        mimeType: this.mimeType || undefined
      });
    } catch (err) {
      segment.state = 'error';
      this.active = null;
      this.running = false;
      this._epoch++;
      for (const t of stream.getTracks()) t.stop();
      this._lastError = err;
      this._emit('recordererror', { segment, error: String(err) });
      this._settleIfDone();
      return;
    }
    this._recorder = recorder;
    segment._recorder = recorder;

    recorder.ondataavailable = (ev) => this._onData(segment, ev);
    recorder.onstop = () =>
      this.enqueue(() => this._onRecorderStop(segment), 'onstop');
    recorder.onerror = (ev) =>
      this.enqueue(
        () => this._onRecorderError(segment, ev),
        'onerror'
      );

    this._bindTracks(segment, stream);

    try {
      recorder.start(this.timeslice);
    } catch (err) {
      segment.state = 'error';
      this.active = null;
      this.running = false;
      for (const t of stream.getTracks()) t.stop();
      this._lastError = err;
      this._emit('recordererror', { segment, error: String(err) });
      this._settleIfDone();
      return;
    }

    this._emit('segmentstart', { segment, stream });
  }

  _bindTracks(segment, stream) {
    segment._trackHandlers = [];
    for (const track of stream.getTracks()) {
      const onEnded = () =>
        this.enqueue(
          () => this._onTrackInterrupt(segment, 'ended', track),
          'track:ended'
        );
      const onMute = () =>
        this.enqueue(
          () => this._onTrackInterrupt(segment, 'mute', track),
          'track:mute'
        );
      track.addEventListener?.('ended', onEnded);
      track.addEventListener?.('mute', onMute);
      segment._trackHandlers.push({ track, onEnded, onMute });
    }
  }

  _unbindTracks(segment) {
    const handlers = segment?._trackHandlers;
    if (!handlers) return;
    for (const h of handlers.splice(0)) {
      h.track.removeEventListener?.('ended', h.onEnded);
      h.track.removeEventListener('mute', h.onMute);
    }
  }

  /**
   * 轨道中断（设备拔出 -> ended；系统静音/物理遮挡 -> mute）。
   * 已封口或属于旧片段的事件一律忽略——迟到事件不能影响当前片段。
   */
  async _onTrackInterrupt(segment, reason, track) {
    if (!this.running) return;
    if (this.active !== segment || segment.state !== 'recording') return;
    await this._sealCurrent(reason);
    await this._failover(reason, null, [segment.deviceId]);
  }

  // ------------------------------------------------------------------ 封口

  /**
   * 明确结束当前片段。幂等：没有活动片段时直接返回。
   * 调用 MediaRecorder.stop() 后立即把段置为 'sealing'，此后：
   *   - 数据块只允许进入仍在 sealing 的本段（归属原片段）；
   *   - 段一旦 sealed，任何迟到块丢弃；
   *   - 活动指针清空，停止后不会再向任何段追加。
   */
  async _sealCurrent(reason) {
    const segment = this.active;
    if (!segment || segment.state !== 'recording') return;

    segment.state = 'sealing';
    segment.reason = reason;
    segment.endedAt = this._now();
    segment.endPerf = segment.endedAt;
    this.active = null;
    this.activeDeviceId = null;
    this.activeRole = null;
    this._sealingCount++;

    const recorder = this._recorder;
    this._recorder = null;

    this._emit('segmentsealing', { segment, reason });

    // 强制封口看门狗：onstop 迟迟不来（某些平台拔设备时会发生）也必须结束。
    const timer = this._setTimeout(() => {
      this.enqueue(() => this._forceSeal(segment, 'stop-timeout'), 'watchdog');
    }, this.stopTimeoutMs);
    segment._stopTimer = timer;

    if (recorder) {
      try {
        // requestData 促使最后一批缓冲尽快吐出；失败无害。
        if (recorder.state !== 'inactive') {
          try { recorder.requestData(); } catch { /* ignore */ }
          recorder.stop();
        } else {
          // 已经 inactive：onstop 不会再来，直接强制封口。
          this._clearTimeout(timer);
          this._finishSeal(segment);
        }
      } catch (err) {
        this._clearTimeout(timer);
        this._finishSeal(segment);
      }
    } else {
      this._clearTimeout(timer);
      this._finishSeal(segment);
    }
  }

  /** MediaRecorder 的 onstop：只允许兑现一次封口。 */
  async _onRecorderStop(segment) {
    if (segment.state !== 'sealing') {
      // 极端迟到的 onstop（看门狗已强制封口）：忽略，不能重开段。
      return;
    }
    if (segment._stopTimer) {
      this._clearTimeout(segment._stopTimer);
      segment._stopTimer = null;
    }
    this._finishSeal(segment);
  }

  _forceSeal(segment, reason) {
    if (segment.state !== 'sealing') return;
    segment._stopTimer = null;
    segment.reason = segment.reason ? `${segment.reason}+${reason}` : reason;
    this._emit('forcedseal', { segment, reason });
    this._finishSeal(segment);
  }

  /** 把已收集的块固化为 Blob + ObjectURL，停止轨道，段转为 sealed。 */
  _finishSeal(segment) {
    if (segment.state === 'sealed') return;
    const mimeType = this.mimeType || undefined;
    let blob;
    try {
      blob = new Blob(segment.chunks, mimeType ? { type: mimeType } : undefined);
    } catch {
      blob = new Blob(segment.chunks);
    }
    segment.chunks = [];
    segment.blob = blob;
    segment.bytes = blob.size;
    segment.url = this.urlObj.createObjectURL(blob);
    segment.state = 'sealed';

    if (segment.stream) {
      for (const t of segment.stream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this._unbindTracks(segment);
    }
    segment._recorder = null;

    this._sealingCount = Math.max(0, this._sealingCount - 1);
    this._emit('segmentsealed', { segment });
    this._settleIfDone();
  }

  // ---------------------------------------------------------- 数据 / 错误

  _onData(segment, ev) {
    // 块只能归属它自己的段；段 sealed/error 后迟到的块一律丢弃，
    // 停止（stop / 接管）后绝不再向新段追加旧记录器的数据。
    if (!segment || segment.state === 'sealed' || segment.state === 'error') {
      return;
    }
    const data = ev?.data;
    if (!data || !data.size) return;
    segment.chunks.push(data);
    this.heldBytes += data.size;
    this._emit('dataheld', {segment,bytes:data.size});

    if (this.heldBytes > this.maxHeldBytes) {
      this.quotaExceeded = true;
      this.enqueue(() => this._onQuotaExceeded(), 'quota');
    }
  }

  async _onRecorderError(segment, ev) {
    this._emit('recordererror', {
      segment,
      error: ev?.error?.message || 'MediaRecorder error'
    });
    if (this.running && this.active === segment) {
      await this._sealCurrent('recorder-error');
      await this._failover('recorder-error', null, [segment.deviceId]);
    }
  }

  async _onQuotaExceeded() {
    if (!this.running) return;
    this._emit('quotaexceeded', {
      heldBytes: this.heldBytes,
      maxHeldBytes: this.maxHeldBytes
    });
    this.running = false;
    await this._sealCurrent('quota-limit');
  }

  // ---------------------------------------------------------- 接管 / 失败

  /**
   * 中断后选择另一台设备开新片段。closure.tried 累计本次接管已试过的设备，
   * 不会回头去开刚拔出/刚拒绝的设备。
   */
  async _failover(reason, closure, exclude = []) {
    if (!this.running) {
      // 停止过程中进入：若留有未闭合缺口，标记接管失败并持续到会话结束。
      if (closure?.gap && closure.gap.to == null) {
        closure.gap.failoverFailed = true;
      }
      this._settleIfDone();
      return;
    }

    const tried = new Set(closure?.tried || []);
    for (const id of exclude) tried.add(id);

    const target = (() => {
      // 刚失败的设备排最后；主备中先试另一台。
      const failed = exclude[0] || closure?.failedId;
      const order =
        failed === this.primaryId
          ? [[this.backupId, 'backup'], [this.primaryId, 'primary']]
          : [[this.primaryId, 'primary'], [this.backupId, 'backup']];
      for (const [id, role] of order) {
        if (!id || tried.has(id)) continue;
        if (!this._isPresent(id)) continue;
        return { id, role };
      }
      return null;
    })();
    if (!target) {
      this.running = false;
      if (closure?.gap && closure.gap.to == null) {
        closure.gap.failoverFailed = true;
      }
      this._lastError = new Error(`no device available after ${reason}`);
      this._emit('failoverfailed', { reason, tried: [...tried] });
      this._settleIfDone();
      return;
    }

    tried.add(target.id);
    const gap = closure?.gap || this._openGapFor(reason);
    await this._beginSegment(target.id, target.role, reason, {
      gap,
      failedId: exclude[0] || closure?.failedId || null,
      tried
    });
  }

  _openGapFor(reason) {
    const prev = this.segments[this.segments.length - 1];
    const gapReason =
      reason === 'mute' ? 'mute'
      : reason === 'permission' ? 'permission'
      : reason === 'recorder-error' ? 'recorder-error'
      : 'disconnect';
    const gap = {
      afterSegment: prev ? prev.index : -1,
      from: prev?.endedAt ?? this._now(),
      to: null,
      reason: gapReason
    };
    this.gaps.push(gap);
    return gap;
  }

  _acquireFailed(deviceId, trigger, err, closure) {
    this._lastError = err;
    this._emit('acquireerror', {
      deviceId,
      trigger,
      error: err?.name || String(err)
    });
    if (trigger === 'start') {
      this.running = false;
      this._epoch++;
      this._settleIfDone();
      return;
    }
    // 中断接管时拿不到设备：让 _failover 改试另一台。
    this.enqueue(
      () => this._failover(trigger, closure, [deviceId]),
      'acquirefail:failover'
    );
  }

  // --------------------------------------------------- 权限失效 / 热插拔

  _watchPermission() {
    let status;
    const onChange = () =>
      this.enqueue(() => this._onPermissionChange(status), 'permission');
    try {
      const perms = this.mediaDevices?.permissions;
      if (!perms?.query) return;
      perms
        .query({ name: 'camera' })
        .then((st) => {
          if (this._disposed) return;
          status = st;
          status.addEventListener?.('change', onChange);
          this._permStatus = status;
          this._permOnChange = onChange;
        })
        .catch(() => {
          /* 不支持 camera 权限查询的平台忽略 */
        });
    } catch {
      /* ignore */
    }
  }

  async _onPermissionChange(status) {
    if (!status || status.state !== 'denied') return;
    if (!this.running || !this.active) return;
    const prev = this.active;
    await this._sealCurrent('permission');
    const gap = {
      afterSegment: prev.index,
      from: prev.endedAt ?? this._now(),
      to: null,
      reason: 'permission'
    };
    this.gaps.push(gap);
    // 权限失效通常两台都拿不到；能拿到就按接管开新段，拿不到则会话结束。
    await this._failover('permission', { gap, failedId: prev.deviceId }, [
      prev.deviceId
    ]);
  }

  _watchDeviceChanges() {
    if (!this.mediaDevices?.addEventListener) return;
    const onChange = () =>
      this.enqueue(() => this._onDeviceChange(), 'devicechange');
    this.mediaDevices.addEventListener('devicechange', onChange);
    this._deviceChangeHandler = onChange;
  }

  async _onDeviceChange() {
    let list = [];
    try {
      list = await this.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    const cams = list.filter((d) => d.kind === 'videoinput');
    const wasPresent = this._deviceList.length;
    this._deviceList = cams;
    this._emit('deviceschanged', { devices: cams.slice() });

    if (!this.running || !this.active) return;

    const currentId = this.active.deviceId;
    const stillThere = cams.some((d) => d.deviceId === currentId);
    // 首次授权前 enumerateDevices 可能只给空 id 列表，这种“变化”不能当拔出。
    if (!stillThere && cams.some((d) => d.deviceId)) {
      // track.ended 通常会先到；这里兜底，防止个别平台不派发 ended。
      if (this.active?.state === 'recording' && wasPresent) {
        await this._onTrackInterrupt(
          this.active,
          'disconnect',
          this.active.stream?.getVideoTracks?.()[0]
        );
      }
    }
  }

  // ---------------------------------------------------------- 配额 / URL

  /** UI 删除某段后调用：回收字节计数（URL 由 revokeSegmentUrl 撤销）。 */
  releaseSegment(index) {
    return this.enqueue(() => {
      const seg = this.segments[index];
      if (!seg || seg.state !== 'sealed') return;
      this.heldBytes = Math.max(0, this.heldBytes - seg.bytes);
      this._revokeUrl(seg);
      seg.blob = null;
      seg.bytes = 0;
      seg.released = true;
      this._emit('segmentreleased', { index });
    }, 'releaseSegment');
  }

  _revokeUrl(seg) {
    if (seg?.url) {
      try { this.urlObj.revokeObjectURL(seg.url); } catch { /* ignore */ }
      seg.url = null;
    }
  }

  /** UI 在用户保存后复位配额标记（或先 releaseSegment 再复位）。 */
  resetQuotaFlag() {
    this.quotaExceeded = false;
  }

  // ---------------------------------------------------------- 时间清单

  /**
   * 导出清单（不落盘，由 UI 触发下载）。每段写明设备、起止时间与时长，
   * 并单独列出所有缺口；相邻段绝不在数据里被合并。
   */
  buildManifest() {
    const sealed = this.segments.filter((s) => s.state === 'sealed');
    return {
      schema: 'dual-camera-recording/v1',
      createdAt: new Date(this._now()).toISOString(),
      mimeType: this.mimeType || null,
      devices: {
        primary: {
          deviceId: this.primaryId,
          label: this._deviceLabel(this.primaryId)
        },
        backup: {
          deviceId: this.backupId,
          label: this._deviceLabel(this.backupId)
        }
      },
      heldBytes: this.heldBytes,
      maxHeldBytes: this.maxHeldBytes,
      segments: this.segments.map((s, i) => ({
        index: i,
        deviceId: s.deviceId,
        deviceLabel: s.label,
        role: s.role,
        startedAt: new Date(s.startedAt).toISOString(),
        endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
        durationMs:
          s.startPerf && s.endPerf ? s.endPerf - s.startPerf : null,
        bytes: s.bytes,
        mimeType: this.mimeType || null,
        file: s.released
          ? null
          : `segment-${String(i).padStart(3, '0')}.webm`,
        endedReason: s.reason || null,
        state: s.state
      })),
      gaps: this.gaps.map((g) => ({
        afterSegment: g.afterSegment,
        from: new Date(g.from).toISOString(),
        to: g.to ? new Date(g.to).toISOString() : null,
        durationMs: g.to ? g.to - g.from : null,
        open: g.to == null,
        failoverFailed: !!g.failoverFailed,
        reason: g.reason
      })),
      sealedCount: sealed.length,
      note:
        'segments are separate files; gaps are periods with NO recording. ' +
        'media never left this machine.'
    };
  }
}
