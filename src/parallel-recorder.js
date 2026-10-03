import { Recorder } from "./recorder-core.js";
import { recordingCoverage } from "./timeline.js";

/**
 * parallel-recorder.js —— 双路同时留证（主、备摄像头同时独立录制）。
 *
 * 与单机位 Recorder 的“主→备接管”语义不同，这里两条车道(primary/backup)
 * 始终并行，彼此隔离：
 *
 *  1. 单路失联（断开/静音/权限失效/录制器错误）只终结【该路】当前片段，
 *     在该路上留下缺口；另一路完全不受影响，继续录制。
 *  2. 只有当两路都无法继续（任一路均无 running 的录制器）时，会话才结束。
 *     替换某一路设备（replace）后该路可重新开段。
 *  3. 每块素材保留【真实设备与真实时间归属】：段按 (startedAt, 路序, 路内序号)
 *     排序得到全局稳定序号，deviceId/role 永远来自实际采集它的录制器。
 *  4. 合计持有容量按两路【实际仍持有】的素材求和；释放一块素材只作用于
 *     归属它的那一路，绝不触碰另一路的字节计数与 ObjectURL。
 *  5. 会话覆盖时长取两路素材时间范围的【并集】（重叠拍摄不重复计时）。
 *  6. 所有片段都 sealed 之后才可交付（deliverable）。
 *
 * 子路各自仍由 recorder-core 的串行队列 enqueue() 保证其内部
 * （getUserMedia / ondataavailable / onstop 交错）归属确定；本层只做
 * 车道级编排，不在子路任务之间穿插修改其状态。
 */

const LANE_EVENTS = [
  "segmentstart",
  "segmentsealing",
  "segmentsealed",
  "segmentreleased",
  "forcedseal",
  "acquireerror",
  "recordererror",
  "deviceschanged",
  "dataheld",
];

function makeEvent(type, detail) {
  try {
    return new CustomEvent(type, { detail });
  } catch {
    return { type, detail };
  }
}

export class ParallelRecorder extends EventTarget {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.primaryId = cfg.devices.primaryId;
    this.backupId = cfg.devices.backupId;
    this.maxHeldBytes = cfg.maxHeldBytes ?? 512 * 1024 * 1024;
    /** role -> 当前车道录制器（替换后会指向新录制器）。 */
    this.lanes = new Map();
    /** 所有车道录制器（含替换前已封口的旧记录），保证旧素材仍可交付/释放。 */
    this.records = [];
    this.devices = [];
    this.running = false;
    this.quotaExceeded = false;
    /** 尚未兑现的封口数（跨所有车道）；全部落定后才派发 settled。 */
    this._sealingCount = 0;
    this._settledFired = true;
    this._whenSettledResolvers = [];
  }

  // ------------------------------------------------------------------ 编排

  setDeviceList(list) {
    this.devices = list;
    for (const x of this.records) x.rec.setDeviceList(list);
  }

  /**
   * 两路【实际仍持有】素材的合计字节数。子路 releaseSegment 后各自的
   * heldBytes 已扣减，这里实时求和即可。
   */
  get heldBytes() {
    return this.records.reduce((n, x) => n + x.rec.heldBytes, 0);
  }

  /**
   * 平铺全部车道的片段，并赋全局稳定序号。
   *
   * 排序键 (startedAt, 路序 ordinal, 路内 index)：
   *  - 同一录制器内序号即开始顺序；不同录制器按真实开始时间排序；
   *  - startedAt 相同（同步开录）时用创建车道的先后（ordinal）兜底，
   *    因此替换设备、迟到封口等情况下全局序号都不会漂移。
   * 每条视图附带归属信息（_owner/_ordinal/_localIndex），仅供本层
   * 释放路由使用。
   */
  _flatSegments() {
    const views = [];
    for (const x of this.records) {
      x.rec.segments.forEach((s, localIndex) => {
        views.push({
          ...s,
          // 真实归属：role/deviceId 永远来自实际采集它的子路，
          // 绝不用另一路的设备 id 覆盖。
          role: x.role,
          deviceId: s.deviceId,
          _owner: x.rec,
          _ordinal: x.ordinal,
          _localIndex: localIndex,
        });
      });
    }
    views.sort(
      (a, b) =>
        a.startedAt - b.startedAt ||
        a._ordinal - b._ordinal ||
        a._localIndex - b._localIndex,
    );
    return views.map((v, i) => ({ ...v, index: i }));
  }

  get segments() {
    return this._flatSegments();
  }

  /** 全部缺口的平铺：afterSegment 重映射为全局序号，并注明所属车道。 */
  get gaps() {
    const localToGlobal = new Map();
    for (const v of this._flatSegments()) {
      localToGlobal.set(v._owner, localToGlobal.get(v._owner) || new Map());
      localToGlobal.get(v._owner).set(v._localIndex, v.index);
    }
    const out = [];
    for (const x of this.records) {
      const map = localToGlobal.get(x.rec);
      for (const g of x.rec.gaps) {
        out.push({
          ...g,
          role: x.role,
          open: g.to == null,
          afterSegment: g.afterSegment < 0 ? -1 : map.get(g.afterSegment) ?? -1,
        });
      }
    }
    return out.sort((a, b) => a.from - b.from || a.role.localeCompare(b.role));
  }

  get mimeType() {
    return this.records[0]?.rec.mimeType || "";
  }

  /** 任一路仍在录制，会话就活着。 */
  _anyLaneAlive() {
    return this.records.some((x) => x.rec.running);
  }

  _beginActivity() {
    this.running = true;
    this._settledFired = false;
  }

  /**
   * 统一的会话状态收口。
   * running 只表示“是否还有任一路在录”，随子路 running 立即变化——
   * 单路失联时另一路在录，running 保持 true；两路都无法继续时立刻为 false，
   * 即使封口仍在兑现。settled 则要等全部封口落定后才派发一次。
   */
  _refreshSessionState() {
    this.running = this._anyLaneAlive();
    if (this.running || this._sealingCount > 0) return;
    if (this._settledFired) return;
    this._settledFired = true;
    const resolvers = this._whenSettledResolvers.splice(0);
    for (const r of resolvers) r();
    this.dispatchEvent(makeEvent("settled", {}));
  }

  // ------------------------------------------------------------------ 生命周期

  async start() {
    if (this.running) return;
    // 全新会话：清掉上一会话遗留的全部车道（撤销其 URL、停轨道）。
    for (const x of this.records) {
      try {
        await x.rec.dispose();
      } catch {
        /* ignore */
      }
    }
    this.records = [];
    this.lanes.clear();
    this._sealingCount = 0;
    this._whenSettledResolvers = [];
    this._settledFired = false;
    this.quotaExceeded = false;
    this.running = true;

    // 两条车道彼此独立打开：一路打不开（缺设备/被拒）不影响另一路开录。
    await Promise.all([
      this.open("primary", this.primaryId),
      this.open("backup", this.backupId),
    ]);
    this._refreshSessionState();
  }

  /**
   * 打开（或替换后重开）一条车道。
   * @param {'primary'|'backup'} role
   * @param {string} id 该车道实际使用的设备
   */
  async open(role, id) {
    const rec = new Recorder({
      ...this.cfg,
      role,
      devices: { primaryId: id, backupId: "" },
      // 子路关闭各自的配额判定：双路容量合并计算，由本层统一执行。
      maxHeldBytes: Infinity,
    });
    const ordinal = this.records.length;
    const entry = { role, rec, ordinal };
    this.lanes.set(role, rec);
    this.records.push(entry);
    rec.setDeviceList(this.devices);
    this._wireLane(role, rec);

    try {
      await rec.start("primary");
    } catch {
      // 打不开该路由子路 acquireerror/failoverfailed 事件体现；
      // 另一路不受影响。此处仅确保会话状态收口。
    }
    this._beginActivity();
    return rec;
  }

  _wireLane(role, rec) {
    for (const type of LANE_EVENTS) {
      rec.addEventListener(type, (e) => {
        const detail = e.detail || {};
        if (detail.segment) detail.segment.role = role;
        if (type === "segmentsealing") this._sealingCount++;
        if (type === "segmentsealed") {
          this._sealingCount = Math.max(0, this._sealingCount - 1);
          queueMicrotask(() => this._refreshSessionState());
        }
        if (type === "dataheld") {
          // 两块素材合并计算容量：任一子录到新块后重新判定合计配额。
          queueMicrotask(() => this.checkQuota());
        }
        this.dispatchEvent(makeEvent(type, detail));
      });
    }

    // 录制器构造/启动直接失败（非接管路径）：该路也已终止，需收口。
    rec.addEventListener("recordererror", () => {
      queueMicrotask(() => this._refreshSessionState());
    });

    // 该路彻底无法继续：只终结这一条车道。
    rec.addEventListener("failoverfailed", (e) => {
      // 忽略来自已被替换掉的旧车道录制器的迟到事件。
      if (this.lanes.get(role) !== rec) return;
      const detail = { ...(e.detail || {}), role };
      this.dispatchEvent(makeEvent("laneended", detail));
      if (!this._anyLaneAlive()) {
        // 两路都无法继续：会话才结束（封口可能仍在兑现，settled 延后派发）。
        this.dispatchEvent(makeEvent("failoverfailed", detail));
      }
      this._refreshSessionState();
    });
  }

  /**
   * 替换某一路设备：旧车道片段立即明确封口（lane-replaced），随后在新设备
   * 上开一条全新车道记录。旧素材保留真实设备/时间归属，仍在清单与交付中。
   */
  async replace(role, id) {
    if (!["primary", "backup"].includes(role)) throw new Error("Invalid role");
    const old = this.lanes.get(role);
    if (old) {
      this.lanes.set(role, null);
      await old.stop("lane-replaced");
    }
    if (role === "primary") this.primaryId = id;
    else this.backupId = id;
    await this.open(role, id);
  }

  /** 用户停止：两条车道都封口（干净结束，不产生缺口）。 */
  async stop(reason = "user-stop") {
    const lanes = [...this.lanes.values()].filter(Boolean);
    if (!lanes.length) {
      this.running = false;
      this._refreshSessionState();
      return;
    }
    await Promise.all(lanes.map((r) => (r.running ? r.stop(reason) : null)));
    this._refreshSessionState();
  }

  /** 等所有车道的封口（onstop / 看门狗）全部兑现。 */
  whenSettled() {
    const noPendingSeals = this.records.every(
      (x) => x.rec._sealingCount === 0,
    );
    if (!this._anyLaneAlive() && this._sealingCount === 0 && noPendingSeals) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._whenSettledResolvers.push(resolve);
    });
  }

  /**
   * 释放一块【已封口】素材：按全局归属路由到唯一的子路本地序号，
   * 只撤销该段自己的 ObjectURL、只扣减该段自己的字节。绝不会遍历
   * 所有车道（那会误释放另一路同序号素材并使其下载资源失效）。
   * @param {number} index 全局片段序号（见 segments 视图）
   */
  async releaseSegment(index) {
    const view = this._flatSegments()[index];
    if (!view) return;
    await view._owner.releaseSegment(view._localIndex);
  }

  async dispose() {
    await this.stop("dispose").catch(() => {});
    await Promise.all(
      this.records.map((x) =>
        x.rec.dispose().catch(() => {
          /* ignore */
        }),
      ),
    );
    this.records = [];
    this.lanes.clear();
    this._sealingCount = 0;
    this.running = false;
  }

  resetQuotaFlag() {
    this.quotaExceeded = false;
    for (const x of this.records) x.rec.resetQuotaFlag();
  }

  // ------------------------------------------------------------------ 配额

  /** 由 UI 在 dataheld 事件后调用（或内部自检）：合计容量超限则停两路。 */
  checkQuota() {
    if (this.quotaExceeded || this.heldBytes <= this.maxHeldBytes) return false;
    this.quotaExceeded = true;
    this.dispatchEvent(
      makeEvent("quotaexceeded", {
        heldBytes: this.heldBytes,
        maxHeldBytes: this.maxHeldBytes,
      }),
    );
    // 超限即明确停止整个会话；已封口素材不受影响。
    Promise.resolve(this.stop("quota-limit")).catch(() => {});
    return true;
  }

  // ------------------------------------------------------------------ 交付清单

  /**
   * 所有片段都已封口（无录制中/封口中）方可交付。替换前的旧车道片段
   * 同样必须 sealed。
   */
  get deliverable() {
    const segs = this._flatSegments();
    return (
      segs.length > 0 && segs.every((s) => s.state === "sealed")
    );
  }

  laneStates() {
    const cur = (role) => {
      const rec = this.lanes.get(role);
      if (!rec) return "idle";
      return rec.running ? "recording" : "ended";
    };
    return { primary: cur("primary"), backup: cur("backup") };
  }

  buildManifest() {
    const segments = this._flatSegments();
    return {
      schema: "parallel-camera-recording/v1",
      createdAt: new Date().toISOString?.() || new Date().toString(),
      heldBytes: this.heldBytes,
      maxHeldBytes: this.maxHeldBytes,
      coverageMs: recordingCoverage(segments),
      lanes: this.laneStates(),
      deliverable: this.deliverable,
      segments: segments.map((s) => ({
        index: s.index,
        deviceId: s.deviceId,
        deviceLabel: s.label,
        role: s.role,
        startedAt: new Date(s.startedAt).toISOString(),
        endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
        durationMs: s.endedAt === null ? null : s.endedAt - s.startedAt,
        bytes: s.bytes,
        state: s.state,
        file: s.released
          ? null
          : `segment-${String(s.index).padStart(3, "0")}.webm`,
        released: !!s.released,
        endedReason: s.reason || null,
      })),
      gaps: this.gaps.map((g) => ({
        afterSegment: g.afterSegment,
        role: g.role,
        from: new Date(g.from).toISOString(),
        to: g.to ? new Date(g.to).toISOString() : null,
        durationMs: g.to ? g.to - g.from : null,
        open: g.to == null,
        failoverFailed: !!g.failoverFailed,
        reason: g.reason,
      })),
      sealedCount: segments.filter((s) => s.state === "sealed").length,
      note:
        "two lanes record independently; each clip keeps its real device and " +
        "time ownership; overlapping time is counted once; media never left " +
        "this machine.",
    };
  }
}
