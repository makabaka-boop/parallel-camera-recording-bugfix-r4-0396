import { Recorder } from "./recorder-core.js";
import { recordingCoverage } from "./timeline.js";

function makeEvent(type, detail) {
  try {
    return new CustomEvent(type, { detail });
  } catch {
    return { type, detail };
  }
}

/**
 * ParallelRecorder —— 主/备两路【同时】留证的聚合层。
 *
 * 核心语义（修复点）：
 *  1. 设备控制：每一路是一个独立的单路 Recorder。单路故障（设备拔出 / 静音 /
 *     权限失效 / 接管失败 / 配额）只终结【该路】的片段，另一路继续录制；
 *     两路都无法继续（或用户整体停止）时会话才结束。
 *  2. 片段归属：每块素材保留真实的设备与时间归属——deviceId 取自实际采集段，
 *     role 是该路角色（替换设备后新素材的设备是新设备、路角色不变），
 *     绝不把新设备素材记到仍在工作的另一路名下。全路索引全局唯一，
 *     释放/下载按索引精确命中所属路。
 *  3. 合计容量：heldBytes 是所有路（含被替换路留下的历史段）当前【实际仍持有】
 *     素材之和；释放一路某段只扣该段，不会使另一路的字节计数/URL 失效；
 *     配额判断也按合计值。
 *  4. 覆盖时长：重叠拍摄时间按时间区间并集计算（见 timeline.js）。
 *  5. 交付：任一路还有 recording/sealing 的段时清单标记为未就绪；
 *     释放只影响被释放的那一块素材。
 */
export class ParallelRecorder extends EventTarget {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.primaryId = cfg.devices.primaryId;
    this.backupId = cfg.devices.backupId;
    this.maxHeldBytes = cfg.maxHeldBytes ?? 512 * 1024 * 1024;
    /** role -> 当前在该路上工作的录制器。 */
    this.lanes = new Map();
    /**
     * 所有创建过的路录制器，按创建顺序排列。替换设备会在同一路角色上创建
     * 新录制器；旧录制器的已封口片段仍属于该路的历史素材，必须保留。
     * @type {Array<{role:string, rec:Recorder}>}
     */
    this.records = [];
    this.devices = [];
    this.quotaExceeded = false;
    /** 会话落定通知（全部路都停止且无封口中段）只发一次。 */
    this._sessionSettled = false;
    this._whenSettledResolvers = [];
  }

  setDeviceList(list) {
    this.devices = list;
    for (const x of this.records) x.rec.setDeviceList(list);
  }

  /** 所有路当前实际仍持有的素材字节数【之和】。 */
  get heldBytes() {
    return this.records.reduce((n, x) => n + x.rec.heldBytes, 0);
  }

  /** 任一路仍在录制，会话就算运行。 */
  get running() {
    return this.records.some((x) => x.rec.running);
  }

  /** 当前活动段的角色（UI 用）。 */
  get activeRole() {
    for (const [role, rec] of this.lanes) if (rec.running) return role;
    return null;
  }

  get activeDeviceId() {
    for (const rec of this.lanes.values()) {
      if (rec.running) return rec.activeDeviceId;
    }
    return null;
  }

  /**
   * 全路片段的扁平视图，索引全局唯一且稳定（按创建顺序）。
   * 每段保留真实设备（s.deviceId）与所属路（role）；额外携带
   * recordId/laneIndex 供释放/下载精确路由到所属录制器。
   */
  get segments() {
    const out = [];
    this.records.forEach((x, recordId) => {
      x.rec.segments.forEach((s, laneIndex) => {
        out.push({
          ...s,
          role: x.role,
          deviceId: s.deviceId,
          recordId,
          laneIndex,
        });
      });
    });
    return out.map((s, i) => ({ ...s, index: i }));
  }

  /** 缺口按所属路携带角色，afterSegment 用全局段索引以免跨路重名。 */
  get gaps() {
    const out = [];
    this.records.forEach((x) => {
      // 该录制器第一段在全局视图中的位置
      let base = 0;
      for (const y of this.records) {
        if (y === x) break;
        base += y.rec.segments.length;
      }
      for (const g of x.rec.gaps) {
        out.push({
          ...g,
          role: x.role,
          afterSegment: g.afterSegment < 0 ? -1 : base + g.afterSegment,
        });
      }
    });
    return out;
  }

  // ------------------------------------------------------------------ 生命周期

  /**
   * 在指定路角色上打开一个新的路录制器。替换设备后旧录制器保留在 records
   * 里（其已封口素材仍在交付清单中），lanes 只指向当前工作的录制器。
   */
  async open(role, id) {
    const rec = new Recorder({
      ...this.cfg,
      devices: { primaryId: id, backupId: "" },
      maxHeldBytes: this.maxHeldBytes,
      // 配额按所有路合计的实际持有量判断
      quotaBytes: () => this.heldBytes,
      onSegmentSealed: () => this._maybeSessionSettled(),
    });
    const entry = { role, rec };
    this.lanes.set(role, rec);
    this.records.push(entry);
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
      "quotaexceeded",
      "segmentreleased",
      "internalerror",
    ]) {
      rec.addEventListener(type, (e) => {
        if (type === "quotaexceeded") this.quotaExceeded = true;
        if (type === "failoverfailed" || type === "quotaexceeded") {
          // 单路故障/超额：只终结这一路，绝不连带停止另一路。
          this._emit("laneended", { role });
          this._maybeSessionSettled();
        }
        this.dispatchEvent(
          makeEvent(type, { ...(e.detail || {}), role })
        );
      });
    }
    // 路录制器的 settled 只用于驱动聚合判定；会话级 settled 统一由
    // _maybeSessionSettled() 在两路都落定时发出（恰好一次）。
    rec.addEventListener("settled", () => this._maybeSessionSettled());

    // 路录制器只有一台设备（放在 primaryId），按主偏好启动；
    // 对外呈现的路角色由本聚合层用 x.role 覆盖。
    await rec.start("primary");
  }

  async start() {
    if (this.running) return;
    this._sessionSettled = false;
    await this.open("primary", this.primaryId);
    // 单路打不开不影响另一路继续取证：备路照常打开。
    await this.open("backup", this.backupId);
    // 极端情况下两路在启动阶段都拿不到设备：会话立即落定。
    this._maybeSessionSettled();
  }

  /**
   * 替换某一路设备：先单独停止该路当前录制器（只封该路的口），再在同一路
   * 角色上用新设备开新录制器。另一路全程不受影响。
   */
  async replace(role, id) {
    if (!["primary", "backup"].includes(role)) throw new Error("Invalid role");
    const old = this.lanes.get(role);
    if (old) await old.stop();
    if (role === "primary") this.primaryId = id;
    else this.backupId = id;
    await this.open(role, id);
    this._maybeSessionSettled();
  }

  /** 用户整体停止：两路分别封口；单路停止不得波及另一路。 */
  async stop() {
    await Promise.all(
      this.records.map((x) => x.rec.stop())
    );
    this._maybeSessionSettled();
  }

  /** 等待所有路（含被替换路）的异步封口全部落定。 */
  whenSettled() {
    if (this._isSettled()) return Promise.resolve();
    return new Promise((resolve) => {
      this._whenSettledResolvers.push(resolve);
    });
  }

  _isSettled() {
    return (
      this.records.length > 0 &&
      this.records.every(
        (x) => !x.rec.running && x.rec.sealingCount === 0
      )
    );
  }

  _maybeSessionSettled() {
    if (this._sessionSettled || !this._isSettled()) return;
    this._sessionSettled = true;
    const resolvers = this._whenSettledResolvers.splice(0);
    for (const r of resolvers) r();
    this._emit("settled", {
      segments: this.segments,
      gaps: this.gaps,
    });
  }

  /**
   * 按全局段索引释放一块素材：只命中所属录制器的那一段。另一路（以及同路
   * 的其他段）的字节计数与 ObjectURL 不受影响。
   */
  async releaseSegment(globalIndex) {
    const found = this._locate(globalIndex);
    if (!found) return;
    const { entry, laneIndex } = found;
    await entry.rec.releaseSegment(laneIndex);
    this._maybeSessionSettled();
  }

  _locate(globalIndex) {
    let seen = 0;
    for (const entry of this.records) {
      const n = entry.rec.segments.length;
      if (globalIndex >= seen && globalIndex < seen + n) {
        return { entry, laneIndex: globalIndex - seen };
      }
      seen += n;
    }
    return null;
  }

  async dispose() {
    await this.stop();
    await Promise.all(this.records.map((x) => x.rec.dispose()));
    this.records = [];
    this.lanes.clear();
    this._maybeSessionSettled();
  }

  resetQuotaFlag() {
    this.quotaExceeded = false;
    for (const x of this.records) x.rec.resetQuotaFlag();
  }

  // ------------------------------------------------------------------ 交付清单

  buildManifest() {
    const segments = this.segments;
    const held = segments.filter((s) => !s.released);
    const busy = segments.some(
      (s) => s.state === "recording" || s.state === "sealing"
    );
    const sealedCount = segments.filter((s) => s.state === "sealed").length;
    return {
      schema: "parallel-camera-recording/v1",
      createdAt: new Date().toISOString(),
      heldBytes: this.heldBytes,
      maxHeldBytes: this.maxHeldBytes,
      coverageMs: recordingCoverage(held),
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
      sealedCount,
      /** 两路都封口（无录制中/封口中段）才允许完成交付。 */
      ready: !busy && sealedCount > 0,
      note:
        "segments are separate files per lane; overlapping lanes count once " +
        "in coverage; gaps are periods with NO recording; media never left " +
        "this machine.",
    };
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(makeEvent(type, detail));
  }
}
