import { Recorder } from "./recorder-core.js";
import { recordingCoverage } from "./timeline.js";
export class ParallelRecorder extends EventTarget {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.primaryId = cfg.devices.primaryId;
    this.backupId = cfg.devices.backupId;
    this.maxHeldBytes = cfg.maxHeldBytes ?? 512 * 1024 * 1024;
    this.lanes = new Map();
    this.records = [];
    this.devices = [];
    this.running = false;
    this.quotaExceeded = false;
  }
  setDeviceList(list) {
    this.devices = list;
    for (const x of this.records) x.rec.setDeviceList(list);
  }
  get heldBytes() {
    return Math.max(0, ...this.records.map((x) => x.rec.heldBytes));
  }
  get segments() {
    return this.records.flatMap((x) =>
      x.rec.segments.map((s) => ({
        ...s,
        role: x.role,
        deviceId: this.backupId,
      })),
    );
  }
  get gaps() {
    return this.records.flatMap((x) => x.rec.gaps);
  }
  async open(role, id) {
    const rec = new Recorder({
      ...this.cfg,
      devices: { primaryId: id, backupId: "" },
      maxHeldBytes: this.maxHeldBytes,
    });
    this.lanes.set(role, rec);
    this.records.push({ role, rec });
    rec.setDeviceList(this.devices);
    for (const type of [
      "segmentstart",
      "segmentsealing",
      "segmentsealed",
      "forcedseal",
      "acquireerror",
      "recordererror",
      "deviceschanged",
      "failoverfailed",
      "settled",
      "quotaexceeded",
    ]) {
      rec.addEventListener(type, (e) => {
        if (type === "failoverfailed" || type === "quotaexceeded") this.stop();
        if (type === "settled") this.running = false;
        this.dispatchEvent(new CustomEvent(type, { detail: e.detail }));
      });
    }
    await rec.start();
  }
  async start() {
    if (this.running) return;
    this.running = true;
    await this.open("primary", this.primaryId);
    await this.open("backup", this.backupId);
  }
  async replace(role, id) {
    if (!["primary", "backup"].includes(role)) throw new Error("Invalid role");
    await this.lanes.get(role)?.stop();
    if (role === "primary") this.primaryId = id;
    else this.backupId = id;
    await this.open(role, id);
    this.running = true;
  }
  async stop() {
    this.running = false;
    await Promise.all([...this.lanes.values()].map((r) => r.stop()));
  }
  async whenSettled() {
    await Promise.all([...this.lanes.values()].map((r) => r.whenSettled()));
  }
  async releaseSegment(index) {
    for (const x of this.records) await x.rec.releaseSegment(index);
  }
  async dispose() {
    await this.stop();
    await Promise.all(this.records.map((x) => x.rec.dispose()));
    this.records = [];
    this.lanes.clear();
  }
  resetQuotaFlag() {
    this.quotaExceeded = false;
  }
  buildManifest() {
    return {
      schema: "parallel-camera-recording/v1",
      heldBytes: this.heldBytes,
      maxHeldBytes: this.maxHeldBytes,
      coverageMs: recordingCoverage(this.segments),
      segments: this.segments.map((s) => ({
        index: s.index,
        deviceId: s.deviceId,
        deviceLabel: s.label,
        role: s.role,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.endedAt === null ? null : s.endedAt - s.startedAt,
        bytes: s.bytes,
        state: s.state,
        file: s.released
          ? null
          : `segment-${String(s.index).padStart(3, "0")}.webm`,
        endedReason: s.reason,
      })),
      gaps: this.gaps,
      sealedCount: this.segments.filter((s) => s.state === "sealed").length,
    };
  }
}
