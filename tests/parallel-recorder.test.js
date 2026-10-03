/**
 * parallel-recorder.test.js — 双路同时留证的并行聚合层测试。
 *
 * 覆盖场景（对应现场故障核对）：
 *   1. 单路失联：只终结该路片段，另一路继续；两路都失效才结束会话。
 *   2. 替换设备：新设备素材记在本路名下且 deviceId 真实；旧段保留。
 *   3. 交错封口：两路数据与 onstop 交错到达时，重叠拍摄不被算成连续延长。
 *   4. 释放一侧：释放一路某段只扣该段，另一路持有字节数与下载 URL 不失效。
 *   5. 合计容量：按所有路实际仍持有素材求和；共享配额按合计触发。
 *
 * 运行：node --test tests/parallel-recorder.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeClock,
  FakeMediaDevices,
  FakeMediaRecorder,
  FakeURL,
  flushMicrotasks
} from './fake-media.js';
import { ParallelRecorder } from '../src/parallel-recorder.js';
import { recordingCoverage } from '../src/timeline.js';

const P = 'cam-primary';
const B = 'cam-backup';
const R = 'cam-replacement';

function makeHarness(opts = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const mediaDevices = new FakeMediaDevices(
    [
      { deviceId: P, label: 'Primary Cam' },
      { deviceId: B, label: 'Backup Cam' },
      { deviceId: R, label: 'Replacement Cam' }
    ].filter((d) => opts.devices ? opts.devices.includes(d.deviceId) : true)
  );
  const urlObj = new FakeURL();
  /** @type {FakeMediaRecorder[]} */
  const recorders = [];
  class MR extends FakeMediaRecorder {
    constructor(stream, o) {
      super(stream, o);
      recorders.push(this);
    }
  }
  MR.isTypeSupported = FakeMediaRecorder.isTypeSupported;
  MR.supportedType = FakeMediaRecorder.supportedType;

  const rec = new ParallelRecorder({
    mediaDevices,
    MediaRecorder: MR,
    urlObj,
    devices: { primaryId: P, backupId: B },
    maxHeldBytes: opts.maxHeldBytes ?? 100_000,
    timeslice: 1000,
    stopTimeoutMs: 5000,
    clock: {
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (id) => clock.clearTimeout(id)
    },
    watchPermission: true,
    watchDeviceChanges: true,
    audio: false
  });
  rec.setDeviceList(mediaDevices.devices);

  const events = [];
  for (const t of ['laneended', 'settled', 'failoverfailed']) {
    rec.addEventListener(t, (e) => events.push({ type: t, detail: e.detail }));
  }

  /** 取当前在指定设备上录制的最新假录制器。 */
  function recorderFor(deviceId) {
    for (let i = recorders.length - 1; i >= 0; i--) {
      const video = recorders[i].stream?.getVideoTracks?.()[0];
      if (video && video.deviceId === deviceId) return recorders[i];
    }
    return null;
  }

  return {
    rec, clock, mediaDevices, urlObj, recorders, events,
    lane: (role) => rec.lanes.get(role),
    recorderFor,
    track: (deviceId) =>
      mediaDevices.activeStreams.get(deviceId).getVideoTracks()[0]
  };
}

async function startBoth(h) {
  await h.rec.start();
  await flushMicrotasks();
  assert.equal(h.recorders.length, 2, '主备两路各开一个录制器');
  return { pmr: h.recorderFor(P), bmr: h.recorderFor(B) };
}

async function stopAndSeal(h, mrs = []) {
  const stopP = h.rec.stop();
  for (const mr of mrs) mr.fireStop();
  await stopP;
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------

test('单路失联只终结该路：主路拔出且备机不可接管时，备路照常录制，会话仍运行', async () => {
  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);

  // 主路内部的备机接管也打不开（该 Recorder 的 backupId 为空，无设备可接管）
  pmr.emitChunk('PRIMARY-1');
  bmr.emitChunk('BACKUP-1');
  assert.equal(h.rec.heldBytes, 'PRIMARY-1'.length + 'BACKUP-1'.length);

  h.track(P).simulateEnded(); // 主设备热拔出
  await flushMicrotasks();

  assert.equal(h.rec.running, true, '备路仍在录，会话不结束');
  assert.equal(h.lane('backup').running, true);
  assert.equal(h.lane('primary').running, false, '只主路停止');

  const laneEnded = h.events.filter((e) => e.type === 'laneended');
  assert.equal(laneEnded.length, 1);
  assert.equal(laneEnded[0].detail.role, 'primary');

  // 主路留下一个打开的缺口（该路自己接管失败），备路无缺口
  const pRec = h.lane('primary');
  assert.equal(pRec.gaps.length, 1);
  assert.equal(pRec.gaps[0].failoverFailed, true);
  assert.equal(h.lane('backup').gaps.length, 0);

  // 备路继续收数据不受影响
  bmr.emitChunk('BACKUP-2');
  assert.equal(h.lane('backup').activeDeviceId, B);

  // 备路数据与主路迟到的 onstop 交错到达
  pmr.fireStop();
  await flushMicrotasks();
  assert.equal(h.lane('primary').segments[0].state, 'sealed');
  assert.equal(h.lane('backup').segments[0].state, 'recording');

  await stopAndSeal(h, [bmr]);
  assert.equal(h.rec.running, false);
  const manifest = h.rec.buildManifest();
  assert.equal(manifest.segments.length, 2);
  // 每块素材保留真实设备与路归属
  assert.deepEqual(
    manifest.segments.map((s) => [s.deviceId, s.role]),
    [[P, 'primary'], [B, 'backup']]
  );
  assert.equal(manifest.gaps.length, 1);
  assert.equal(manifest.gaps[0].role, 'primary');
  assert.equal(manifest.gaps[0].open, true);
});

test('两路都无法继续时会话才结束（主、备先后失联，settled 只发一次）', async () => {
  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);

  h.track(P).simulateEnded();
  await flushMicrotasks();
  assert.equal(h.rec.running, true, '主路没了，备路仍在');

  h.track(B).simulateEnded();
  await flushMicrotasks();
  pmr.fireStop();
  bmr.fireStop();
  await flushMicrotasks();

  assert.equal(h.rec.running, false, '两路都结束');
  const settled = h.events.filter((e) => e.type === 'settled');
  assert.equal(settled.length, 1, '会话级 settled 恰好一次');
  const manifest = h.rec.buildManifest();
  assert.equal(manifest.ready, true);
  assert.equal(manifest.sealedCount, 2);
});

test('替换主路设备：旧段保留，新素材 deviceId 真实且仍归主路，备路不受影响', async () => {
  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);
  pmr.emitChunk('OLD-PRIMARY');
  bmr.emitChunk('BACKUP-DATA');
  h.clock.tick(400);

  // 在选择器里改成新设备，然后替换主路
  const replaceP = h.rec.replace('primary', R);
  await flushMicrotasks();
  pmr.fireStop(); // 旧主路录制器的 onstop 与新主路启动交错
  await replaceP;
  await flushMicrotasks();

  const rmr = h.recorderFor(R);
  assert.ok(rmr && rmr !== pmr, '替换后主路是新录制器');
  assert.equal(h.lane('primary').activeDeviceId, R);
  assert.equal(h.lane('primary').activeRole, 'primary');
  assert.equal(h.lane('backup').activeDeviceId, B, '备路设备未被串改');
  assert.equal(h.rec.primaryId, R);

  rmr.emitChunk('NEW-PRIMARY');
  assert.equal(h.rec.running, true);

  await stopAndSeal(h, [rmr, bmr]);

  const manifest = h.rec.buildManifest();
  // 段顺序：旧主路段、备路段、新主路段（按录制器创建顺序）
  assert.deepEqual(
    manifest.segments.map((s) => [s.deviceId, s.role, s.index]),
    [
      [P, 'primary', 0],
      [B, 'backup', 1],
      [R, 'primary', 2]
    ],
    '新设备素材不得记到仍在工作的备路名下'
  );
  assert.equal(manifest.segments[0].file, 'segment-000.webm');
  assert.equal(manifest.segments[2].file, 'segment-002.webm', '全局索引唯一');
  // 新段的设备标签取自真实设备
  assert.equal(manifest.segments[2].deviceLabel, 'Replacement Cam');
});

test('交错封口：两路重叠拍摄的覆盖时长按时间并集计算，不算成连续延长', async () => {
  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);

  // 两路在完全相同的墙钟区间各录 1000ms
  h.clock.tick(1000);
  pmr.emitChunk('P');
  bmr.emitChunk('B');
  await stopAndSeal(h, [pmr, bmr]);

  const segs = h.rec.segments;
  assert.equal(segs.length, 2);
  const sum = segs.reduce((n, s) => n + (s.endedAt - s.startedAt), 0);
  assert.equal(sum, 2000, '原始两段时长之和是 2000（重叠）');
  const coverage = recordingCoverage(segs);
  assert.equal(coverage, 1000, '并集覆盖只算一次重叠时间');
  assert.equal(h.rec.buildManifest().coverageMs, 1000);
});

test('交错封口：部分重叠 + 各自独占区间合并正确', async () => {
  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);
  // 主路 [0,1000)，备路 [500,2000)：并集应为 [0,2000) = 2000
  h.clock.tick(1000);
  pmr.emitChunk('P');
  await h.rec.lanes.get('primary').stop();
  pmr.fireStop();
  await flushMicrotasks();
  h.clock.tick(1000);
  bmr.emitChunk('B');
  await h.rec.lanes.get('backup').stop();
  bmr.fireStop();
  await flushMicrotasks();
  const coverage = recordingCoverage(h.rec.segments);
  assert.equal(coverage, 2000, '重叠 500 不重复计，缺口为 0');
});

test('释放一路素材只释放该段：另一路持有字节数与下载 URL 保持有效', async () => {
  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);
  pmr.emitChunk('PPPPPP'); // 6
  bmr.emitChunk('BBBBBBBBBB'); // 10
  await stopAndSeal(h, [pmr, bmr]);

  assert.equal(h.rec.heldBytes, 16, '合计容量按两路实际持有求和');
  const segs = h.rec.segments;
  const backupUrl = segs[1].url;
  assert.ok(backupUrl);

  // 释放主路那一块（全局索引 0）
  await h.rec.releaseSegment(0);
  await flushMicrotasks();

  assert.equal(h.rec.heldBytes, 10, '只剩备路的 10 字节');
  assert.equal(h.rec.lanes.get('primary').heldBytes, 0);
  assert.equal(h.rec.lanes.get('backup').heldBytes, 10, '备路计数不被波及');

  const after = h.rec.buildManifest();
  assert.equal(after.segments[0].file, null, '主路段已释放，无下载文件');
  assert.equal(after.segments[0].bytes, 0);
  assert.equal(after.segments[1].file, 'segment-001.webm', '备路仍可交付');
  assert.ok(!h.urlObj.revoked.includes(backupUrl), '备路 URL 未被撤销');
  // 已释放段不计入覆盖：两段都在同一 tick（时长 0），释放后仍为 0
  assert.equal(after.coverageMs, 0);
});

test('共享配额：一路超出的是两路合计持有量，且只自动停止该路', async () => {
  const h = makeHarness({ maxHeldBytes: 10 });
  const { pmr, bmr } = await startBoth(h);
  pmr.emitChunk('123456'); // 合计 6
  bmr.emitChunk('12345');  // 合计 11 > 10 —— 由备路这块触发
  await flushMicrotasks();

  assert.equal(h.lane('backup').running, false, '触发超额的备路停止');
  assert.equal(h.lane('primary').running, true, '主路继续（单路故障不连坐）');
  assert.equal(h.rec.quotaExceeded, true);
  assert.equal(h.events.filter((e) => e.type === 'laneended').length, 1);
});

test('整体停止与单路封口交错：两路各自独立封口，不互相重开片段', async () => {
  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);
  pmr.emitChunk('P1');
  bmr.emitChunk('B1');

  // 主路先整体停止入队，备路块与 onstop 交错
  const stopP = h.rec.stop();
  bmr.emitChunk('B2');         // 停止意图后、封口任务前的在途块仍归备路段
  pmr.fireStop();
  await flushMicrotasks();
  bmr.fireStop();
  await stopP;
  await flushMicrotasks();

  assert.equal(h.rec.segments.length, 2, '停止后不产生新片段');
  assert.deepEqual(
    h.rec.segments.map((s) => s.state),
    ['sealed', 'sealed']
  );
  const pseg = h.rec.lanes.get('primary').segments[0];
  const bseg = h.rec.lanes.get('backup').segments[0];
  assert.equal(Buffer.from(await pseg.blob.arrayBuffer()).toString(), 'P1');
  assert.equal(Buffer.from(await bseg.blob.arrayBuffer()).toString(), 'B1B2');
});

test('交付门控：任一路仍在录制/封口时清单 ready=false，全部封口后才就绪', async () => {
  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);
  pmr.emitChunk('P');
  bmr.emitChunk('B');

  // 只停主路，备路还在录
  await h.rec.lanes.get('primary').stop();
  pmr.fireStop();
  await flushMicrotasks();
  let manifest = h.rec.buildManifest();
  assert.equal(manifest.ready, false, '备路仍在录制，不能完成交付');

  await h.rec.lanes.get('backup').stop();
  bmr.fireStop();
  await flushMicrotasks();
  manifest = h.rec.buildManifest();
  assert.equal(manifest.ready, true, '两路都封口后可交付');
});

test('两路启动都拿不到设备：会话明确结束且 settled 兑现', async () => {
  const h = makeHarness();
  h.mediaDevices.failures.set(P, 'deny');
  h.mediaDevices.failures.set(B, 'deny');

  let settled = false;
  h.rec.whenSettled().then(() => { settled = true; });
  await h.rec.start();
  await flushMicrotasks();

  assert.equal(h.rec.running, false);
  assert.equal(settled, true, '会话落定 Promise 必须兑现');
  assert.equal(h.rec.buildManifest().ready, false, '没有任何成品段，不可交付');
});

test('whenSettled 等齐所有路（含被替换路）的异步封口', async () => {  const h = makeHarness();
  const { pmr, bmr } = await startBoth(h);
  pmr.emitChunk('P');
  bmr.emitChunk('B');

  const replaceP = h.rec.replace('primary', R);
  await flushMicrotasks();
  const rmr = h.recorderFor(R);
  rmr.emitChunk('R');

  const stopP = h.rec.stop();
  // 三个录制器（旧主、备、新主）的 onstop 全部迟到
  let settledDone = false;
  h.rec.whenSettled().then(() => { settledDone = true; });
  await flushMicrotasks();
  assert.equal(settledDone, false, '还有封口中段');

  pmr.fireStop();
  await flushMicrotasks();
  assert.equal(settledDone, false);
  bmr.fireStop();
  await flushMicrotasks();
  assert.equal(settledDone, false);
  rmr.fireStop();
  await replaceP;
  await stopP;
  await flushMicrotasks();
  assert.equal(settledDone, true, '全部封口落定');
  assert.equal(h.rec.buildManifest().sealedCount, 3);
});
