/**
 * fake-media.js — 可控媒体对象（测试专用）。
 *
 * 与真实浏览器的对应关系：
 *   FakeMediaDevices  : navigator.mediaDevices（getUserMedia / enumerateDevices /
 *                       devicechange / permissions）
 *   FakeMediaStream   : MediaStream（getTracks/getVideoTracks）
 *   FakeMediaStreamTrack : MediaStreamTrack（muted / readyState + ended/mute 事件，
 *                       可在任意时刻“拔出/静音”）
 *   FakeMediaRecorder : MediaRecorder（start/stop/requestData/ondataavailable/onstop）
 *                       —— 数据块与 stop 回调的时序完全由测试控制，
 *                       专门用来制造“迟到块 / stop 后 onstop 交错”的竞争。
 *   FakeURL           : createObjectURL / revokeObjectURL，记录每次撤销。
 *   FakeClock         : 可控 now + 手动刷新的 setTimeout（watchdog）。
 */

// Node 20 起 EventTarget / Event / Blob 均为全局对象。
export class FakeClock {
  constructor(start = 1_700_000_000_000) {
    this.t = start;
    this._timers = new Map();
    this._id = 0;
  }
  now() {
    return this.t;
  }
  tick(ms) {
    this.t += ms;
    const due = [...this._timers.values()]
      .filter((x) => x.at <= this.t)
      .sort((a, b) => a.at - b.at);
    for (const entry of due) {
      if (!this._timers.has(entry.id)) continue;
      this._timers.delete(entry.id);
      entry.fn();
    }
  }
  setTimeout(fn, ms) {
    const id = ++this._id;
    this._timers.set(id, { id, at: this.t + (ms || 0), fn });
    return id;
  }
  clearTimeout(id) {
    this._timers.delete(id);
  }
  pendingTimers() {
    return this._timers.size;
  }
}

export class FakeMediaStreamTrack extends EventTarget {
  constructor(kind, deviceId, label) {
    super();
    this.kind = kind;
    this.deviceId = deviceId;
    this.label = label;
    this.id = `track-${deviceId}-${kind}-${Math.random().toString(36).slice(2, 7)}`;
    this.muted = false;
    this.readyState = 'live';
    this.stopped = false;
  }
  stop() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.stopped = true;
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
  /** 测试用：模拟系统把轨道静音（浏览器语义：不派发 unmute 前持续无数据）。 */
  simulateMute() {
    if (this.readyState !== 'live' || this.muted) return;
    this.muted = true;
    this.dispatchEvent(new Event('mute'));
  }
  /** 测试用：模拟设备热拔出 —— 浏览器会置 ended 并派发 ended。 */
  simulateEnded() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.muted = true;
    this.dispatchEvent(new Event('ended'));
  }
}

export class FakeMediaStream {
  constructor(tracks) {
    this._tracks = tracks;
    this.id = `stream-${Math.random().toString(36).slice(2, 8)}`;
    this.active = true;
  }
  getTracks() {
    return this._tracks.slice();
  }
  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio');
  }
}

let recorderSeq = 0;

export class FakeMediaRecorder extends EventTarget {
  static supportedType = 'video/webm;codecs=vp8,opus';
  static isTypeSupported(t) {
    return t === this.supportedType || t === 'video/webm';
  }

  constructor(stream, opts = {}) {
    super();
    this.stream = stream;
    this.options = opts;
    this.state = 'inactive';
    this.seq = recorderSeq++;
    this.timeslice = null;
    this.started = false;
    this.stopCalled = false;
    this.requestDataCount = 0;
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    // 测试可让构造直接抛错
    if (FakeMediaRecorder.constructError) {
      const e = FakeMediaRecorder.constructError;
      FakeMediaRecorder.constructError = null;
      throw e;
    }
  }

  start(timeslice) {
    if (this.state !== 'inactive') throw new Error('already started');
    this.state = 'recording';
    this.started = true;
    this.timeslice = timeslice;
  }

  requestData() {
    this.requestDataCount++;
    if (this.state !== 'recording') throw new Error('not recording');
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.stopCalled = true;
    // 故意【不】立刻派发 onstop —— 真实浏览器里它是异步的，
    // 时序由测试通过 fireStop() 控制，以复现竞争。
  }

  /** 测试用：向【本段】推一个数据块。 */
  emitChunk(bytes) {
    const data = Buffer.from(bytes);
    const ev = { data: new Blob([data], { type: this.options.mimeType || 'video/webm' }) };
    if (typeof this.ondataavailable === 'function') this.ondataavailable(ev);
  }

  /** 测试用：补发 MediaRecorder 的异步 onstop。 */
  fireStop() {
    if (typeof this.onstop === 'function') this.onstop({});
  }

  fireError(message = 'recorder boom') {
    const ev = { error: new Error(message) };
    if (typeof this.onerror === 'function') this.onerror(ev);
  }
}

export class FakePermissionStatus extends EventTarget {
  constructor(state) {
    super();
    this.state = state;
  }
  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new Event('change'));
  }
}

export class FakeMediaDevices extends EventTarget {
  /**
   * @param {Array<{deviceId:string,label:string,kind?:string}>} devices
   */
  constructor(devices = []) {
    super();
    this.devices = devices.map((d) => ({
      kind: 'videoinput',
      label: d.label || `cam-${d.deviceId}`,
      deviceId: d.deviceId,
      ...d
    }));
    /** deviceId -> 'deny' | 'throw' | null */
    this.failures = new Map();
    this.getUserMediaCalls = [];
    this.permissionStatus = new FakePermissionStatus('granted');
    /** 最近一次 getUserMedia 产出的流，按 deviceId 记录，方便测试拔设备。 */
    this.activeStreams = new Map();
    /** 测试钩子：getUserMedia 成功前被调用（参数为目标 deviceId），可用来拨时钟造缺口。 */
    this.onAcquireDelay = null;
  }

  setDevices(list) {
    this.devices = list.map((d) => ({ kind: 'videoinput', ...d }));
  }

  removeDevice(deviceId) {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    this.emitDeviceChange();
    // 该设备的活动轨道真实地结束
    const s = this.activeStreams.get(deviceId);
    if (s) for (const t of s.getTracks()) t.simulateEnded?.();
  }

  /** 仅从枚举列表移除（不派发 track.ended），用于测试 devicechange 兜底路径。 */
  removeDeviceNoEvent(deviceId) {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
  }

  emitDeviceChange() {
    this.dispatchEvent(new Event('devicechange'));
  }

  async enumerateDevices() {
    return this.devices.map((d) => ({ ...d }));
  }

  get permissions() {
    const self = this;
    return {
      async query() {
        return self.permissionStatus;
      }
    };
  }

  async getUserMedia(constraints) {
    const id =
      constraints.video?.deviceId?.exact ||
      constraints.audio?.deviceId?.exact;
    this.getUserMediaCalls.push(id);
    await Promise.resolve(); // 模拟异步，暴露 await 期间的竞争
    const mode = this.failures.get(id);
    if (mode === 'throw') {
      const err = new Error(`device ${id} boom`);
      err.name = 'NotReadableError';
      throw err;
    }
    if (mode === 'deny') {
      const err = new Error('denied');
      err.name = 'NotAllowedError';
      throw err;
    }
    if (!this.devices.some((d) => d.deviceId === id)) {
      const err = new Error('device gone');
      err.name = 'OverconstrainedError';
      throw err;
    }
    if (this.onAcquireDelay) await this.onAcquireDelay(id);
    const tracks = [new FakeMediaStreamTrack('video', id, `cam-${id}`)];
    if (constraints.audio) {
      tracks.push(new FakeMediaStreamTrack('audio', id, `mic-${id}`));
    }
    const stream = new FakeMediaStream(tracks);
    this.activeStreams.set(id, stream);
    return stream;
  }
}

export class FakeURL {
  constructor() {
    this.created = [];
    this.revoked = [];
    this._seq = 0;
  }
  createObjectURL(blob) {
    const url = `blob:fake/${++this._seq}`;
    this.created.push({ url, size: blob?.size ?? 0 });
    return url;
  }
  revokeObjectURL(url) {
    this.revoked.push(url);
  }
}

/** 微任务排空：让 enqueue 链上的所有 await 都走完。 */
export async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}
