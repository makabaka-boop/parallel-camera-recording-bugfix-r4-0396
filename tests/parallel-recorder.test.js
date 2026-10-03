/**
 * parallel-recorder.test.js —— 双路同时留证的车道隔离与归属语义测试。
 *
 * 覆盖：
 *   1. 单路失联：只终结该路片段，另一路不受影响；两路都无法继续才结束会话。
 *   2. 替换设备：新设备素材记在【本路 + 真实设备】名下，旧素材归属不变。
 *   3. 两路数据/停止回调交错：迟到块各归各段，覆盖时长按区间并集（不翻倍）。
 *   4. 释放一侧素材：只扣该路字节、只撤销该路 URL；另一侧仍可交付。
 *   5. 合计容量按实际仍持有素材计算，超限统一停止两路。
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
  flushMicrotasks,
} from './fake-media.js';
import { ParallelRecorder } from '../src/parallel-recorder.js';
import { recordingCoverage } from '../src/timeline.js';

const P = 'cam-primary';
const B = 'cam-backup';
const C = 'cam-replacement';

function makeHarness(opts = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const mediaDevices = new FakeMediaDevices([
    { deviceId: P, label: 'Primary Cam' },
    { deviceId: B, label: 'Backup Cam' },
    { deviceId: C, label: 'Replacement Cam' },
  ]);
  const urlObj = new FakeURL();
  const recorders = [];
  class MR extends FakeMediaRecorder {
    constructor(stream, o) {
      super(stream, o);
      recorders.push(this);
    }
  }
  MR.isTypeSupported = FakeMediaRecorder.isTypeSupported;
  MR.supportedType = FakeMediaRecorder.supportedType;

  const par = new ParallelRecorder({
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
      clearTimeout: (id) => clock.clearTimeout(id),
    },
    watchPermission: true,
    watchDeviceChanges: true,
    audio: false,
  });
  par.setDeviceList(mediaDevices.devices);

  /** @type {{type:string,detail:any}[]} */
  const events = [];
  for (const t of [
    'segmentstart', 'segmentsealing', 'segmentsealed',
    'laneended', 'failoverfailed', 'settled', 'quotaexceeded',
    'segmentreleased',
  ]) {
    par.addEventListener(t, (e) => events.push({ type: t, detail: e.detail }));
  }

  /** 找到某设备当前活动录制器（按流上的设备 id）。 */
  function recorderFor(deviceId) {
    const stream = mediaDevices.activeStreams.get(deviceId);
    return recorders.find((r) => r.stream === stream);
  }

  return {
    par, clock, mediaDevices, urlObj, recorders, events,
    mrP: () => recorderFor(P),
    mrB: () => recorderFor(B),
    mrC: () => recorderFor(C),
  };
}

async function startBoth(h) {
  await h.par.start();
  await flushMicrotasks();
}

test('单路失联：只封口该路、留开放缺口；另一路继续录制，会话仍存活', async () => {
  const h = makeHarness();
  await startBoth(h);
  const mrP = h.mrP();
  const mrB = h.mrB();
  assert.ok(mrP && mrB, '两路都已开录');
  assert.equal(h.par.running, true);

  h.clock.tick(1000);
  mrP.emitChunk('PRIMARY-1234'); // 12
  mrB.emitChunk('BACKUP-56789'); // 12

  // 主路设备热拔出（track.ended）→ 主路在自身队列内封口并尝试接管；
  // 该车道没有第二台设备，接管失败，主路终止。
  h.mediaDevices.activeStreams.get(P).getVideoTracks()[0].simulateEnded();
  await flushMicrotasks();

  assert.equal(h.par.running, true, '备路仍在录制，会话不结束');
  assert.equal(h.par.lanes.get('primary').running, false, '主路已终止');
  assert.equal(h.par.lanes.get('backup').running, true, '备路继续');

  // 主路缺口保持打开（该车道无设备可接管），且只属于主路
  const gaps = h.par.gaps;
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].role, 'primary');
  assert.equal(gaps[0].open, true);
  assert.equal(gaps[0].failoverFailed, true);
  assert.equal(gaps[0].reason, 'disconnect');

  // 主路片段已封口（等 onstop）；备路片段仍在录制
  const segs = h.par.segments;
  assert.equal(segs.length, 2);
  assert.equal(segs[0].state, 'sealing');
  assert.equal(segs[0].role, 'primary');
  assert.equal(segs[0].deviceId, P, '主路片段归属真实主设备');
  assert.equal(segs[1].state, 'recording');
  assert.equal(segs[1].role, 'backup');

  assert.ok(
    h.events.some((e) => e.type === 'laneended' && e.detail.role === 'primary'),
    '派发 laneended(primary)'
  );
  assert.ok(
    !h.events.some((e) => e.type === 'failoverfailed'),
    '单路失联不派发会话级 failoverfailed（会话仍活）'
  );
  assert.ok(
    !h.events.some((e) => e.type === 'settled'),
    '封口未落定 + 备路在录，不派发 settled'
  );

  // 备路此时仍能持续收到新数据
  h.clock.tick(500);
  mrB.emitChunk('BACKUP-ALIVE'); // 12
  const backupView = h.par.segments.find((s) => s.role === 'backup');
  const backupBytes = Buffer.concat(
    await Promise.all(backupView.chunks.map(async (c) =>
      Buffer.from(await c.arrayBuffer()))),
  ).toString();
  assert.equal(backupBytes, 'BACKUP-56789BACKUP-ALIVE');

  // 两路素材合计容量
  assert.equal(h.par.heldBytes, 36);

  // 兑现主路 onstop；主路 sealed，备路仍在录
  mrP.fireStop();
  await flushMicrotasks();
  assert.equal(h.par.running, true);
  assert.equal(h.par.segments[0].state, 'sealed');

  // 用户停止：只停止仍在录的备路，主路封口原因保持原样
  await h.par.stop();
  mrB.fireStop();
  await flushMicrotasks();

  assert.equal(h.par.running, false);
  const manifest = h.par.buildManifest();
  assert.equal(manifest.segments.length, 2);
  assert.equal(manifest.segments[0].endedReason, 'ended');
  assert.equal(manifest.segments[1].endedReason, 'user-stop');
  assert.equal(manifest.deliverable, true);
});

test('两路都无法继续：会话才结束（settled），两条开放缺口分列', async () => {
  const h = makeHarness();
  await startBoth(h);
  const mrP = h.mrP();
  const mrB = h.mrB();

  h.mediaDevices.activeStreams.get(P).getVideoTracks()[0].simulateEnded();
  await flushMicrotasks();
  assert.equal(h.par.running, true, '主路失联后备路仍活');

  h.mediaDevices.activeStreams.get(B).getVideoTracks()[0].simulateEnded();
  await flushMicrotasks();
  assert.equal(h.par.running, false, '两路都无法继续，会话结束');
  assert.ok(
    h.events.some((e) => e.type === 'failoverfailed'),
    '两路尽失才派发会话级 failoverfailed'
  );

  // 两路 onstop 交错到达后才 settled
  mrP.fireStop();
  await flushMicrotasks();
  assert.ok(!h.events.some((e) => e.type === 'settled'), '备路封口未兑现');
  mrB.fireStop();
  await flushMicrotasks();
  assert.ok(h.events.some((e) => e.type === 'settled'));

  const gaps = h.par.gaps;
  assert.equal(gaps.length, 2);
  assert.deepEqual(gaps.map((g) => g.role).sort(), ['backup', 'primary']);
  assert.ok(gaps.every((g) => g.open && g.failoverFailed));

  const manifest = h.par.buildManifest();
  assert.equal(manifest.lanes.primary, 'ended');
  assert.equal(manifest.lanes.backup, 'ended');
});

test('替换一路设备：新素材记在该路真实新设备名下，旧素材归属与序号稳定', async () => {
  const h = makeHarness();
  await startBoth(h);
  const mrP0 = h.mrP();
  const mrB = h.mrB();

  h.clock.tick(1000);
  mrP0.emitChunk('OLD-PRIMARY'); // 11
  mrB.emitChunk('BACKUP-A'); // 8

  // 替换主路：主路旧片段以 lane-replaced 封口，随后在新设备 C 上开新片段
  const replaceP = h.par.replace('primary', C);
  await flushMicrotasks(2);
  // 旧主路 onstop 与新车道开录交错：旧 onstop 故意迟到
  const mrC = h.mrC();
  assert.ok(mrC, '新车道已在替换设备上开录');
  await replaceP;
  await flushMicrotasks();
  mrP0.fireStop();
  await flushMicrotasks();

  assert.equal(h.par.lanes.get('primary').running, true, '新主路在录');
  assert.equal(h.par.lanes.get('backup').running, true, '备路从未中断');

  h.clock.tick(500);
  mrC.emitChunk('NEW-PRIMARY'); // 11
  mrB.emitChunk('BACKUP-B'); // 8

  await h.par.stop();
  mrC.fireStop();
  mrB.fireStop();
  await flushMicrotasks();

  const manifest = h.par.buildManifest();
  assert.equal(manifest.segments.length, 3);

  // 全局序号按真实开始时间排序：旧主(t0) / 备(t0, ordinal 在后) / 新主(t1000)
  const [s0, s1, s2] = manifest.segments;
  assert.equal(s0.role, 'primary');
  assert.equal(s0.deviceId, P, '旧主段仍是真实旧设备');
  assert.equal(s0.endedReason, 'lane-replaced');
  assert.equal(s1.role, 'backup');
  assert.equal(s1.deviceId, B);
  assert.equal(s2.role, 'primary');
  assert.equal(s2.deviceId, C, '新设备素材记在主路 + 真实新设备名下');
  assert.notEqual(s0.file, s2.file, '两块主路素材文件名不同');

  // 旧主段与备段 startedAt 相同（同步开录），靠路序稳定排序，重跑不漂移
  const second = h.par.buildManifest().segments.map((s) => [s.role, s.deviceId]);
  assert.deepEqual(second, [
    ['primary', P], ['backup', B], ['primary', C],
  ]);

  assert.equal(manifest.heldBytes, 38, '合计按实际持有计算');
  assert.equal(manifest.deliverable, true);
});

test('交错封口：两路迟到块各归各段，覆盖时长按区间并集（重叠不翻倍）', async () => {
  const h = makeHarness();
  await startBoth(h);
  const mrP = h.mrP();
  const mrB = h.mrB();

  // t=0 两路同时开录
  h.clock.tick(1000);
  mrP.emitChunk('P1');
  mrB.emitChunk('B1');

  await h.par.stop();
  await flushMicrotasks();
  // 两路都进入 sealing，但 onstop 都尚未到达
  const sealing = h.par.segments;
  assert.ok(sealing.every((s) => s.state === 'sealing'));
  assert.equal(h.par.running, false, '两路停止意图同步生效，会话不再录');

  // 交错到达：主 onstop 先、数据迟到；备数据迟到后 onstop
  mrP.fireStop();
  await flushMicrotasks();
  assert.equal(h.par.segments.find((s) => s.role === 'primary').state, 'sealed');
  assert.equal(h.par.segments.find((s) => s.role === 'backup').state, 'sealing');

  const mrPLate = mrP;
  mrPLate.emitChunk('P-LATE'); // 极迟到块：主段已 sealed，必须丢弃
  mrB.emitChunk('B-LATE2'); // 备仍在 sealing：归备段
  await flushMicrotasks();
  mrB.fireStop();
  await flushMicrotasks();

  const segs = h.par.segments;
  assert.ok(segs.every((s) => s.state === 'sealed'));
  const primary = segs.find((s) => s.role === 'primary');
  const backup = segs.find((s) => s.role === 'backup');
  assert.equal(
    Buffer.from(await primary.blob.arrayBuffer()).toString(),
    'P1',
    '主段迟到块丢弃'
  );
  assert.equal(
    Buffer.from(await backup.blob.arrayBuffer()).toString(),
    'B1B-LATE2',
    '备段 sealing 期间迟到块仍归备段'
  );

  // 两路时间段完全重叠（同开始、同结束=1000ms 墙钟）：
  // 并集覆盖 = 1000ms，绝不是逐段累加的 2000ms。
  assert.equal(recordingCoverage(segs), 1000);
  assert.equal(h.par.buildManifest().coverageMs, 1000);

  // 部分重叠的区间并集：[0,1000] 与 [500,2000] -> 2000
  const crafted = [
    { startedAt: 0, endedAt: 1000 },
    { startedAt: 500, endedAt: 2000 },
    { startedAt: 5000, endedAt: 6000 },
  ];
  assert.equal(recordingCoverage(crafted), 3000);
  assert.equal(recordingCoverage([]), 0);
  assert.equal(recordingCoverage([{ startedAt: 10, endedAt: null }]), 0);
});

test('释放一侧素材：只扣该路字节、只撤销该路 URL；另一侧素材与交付不受影响', async () => {
  const h = makeHarness();
  await startBoth(h);
  const mrP = h.mrP();
  const mrB = h.mrB();

  h.clock.tick(1000);
  mrP.emitChunk('PRIMARY-DATA'); // 12
  mrB.emitChunk('BACKUP-DATA!!'); // 13

  await h.par.stop();
  mrP.fireStop();
  mrB.fireStop();
  await flushMicrotasks();

  const before = h.par.buildManifest();
  assert.equal(before.segments.length, 2);
  assert.equal(before.heldBytes, 25);
  const primary = before.segments.find((s) => s.role === 'primary');
  const backup = before.segments.find((s) => s.role === 'backup');
  const pUrl = h.par.segments[primary.index].url;
  const bUrl = h.par.segments[backup.index].url;
  assert.ok(pUrl && bUrl && pUrl !== bUrl);

  // 释放主路那一块（全局序号路由到唯一子路，不误伤备路同本地序号）
  await h.par.releaseSegment(primary.index);
  await flushMicrotasks();

  assert.ok(h.urlObj.revoked.includes(pUrl), '主路自己的 URL 被撤销');
  assert.ok(!h.urlObj.revoked.includes(bUrl), '备路 URL 仍然有效');
  assert.equal(h.par.heldBytes, 13, '合计只扣掉主路 12 字节');

  const after = h.par.buildManifest();
  const ap = after.segments.find((s) => s.role === 'primary');
  const ab = after.segments.find((s) => s.role === 'backup');
  assert.equal(ap.file, null, '已释放块不再提供文件名');
  assert.equal(ap.released, true);
  assert.equal(ab.file, `segment-${String(backup.index).padStart(3, '0')}.webm`);
  assert.equal(ab.bytes, 13, '备路字节数不变');
  assert.equal(after.deliverable, true, '释放一侧不影响整体可交付');
  assert.equal(after.coverageMs, 1000, '覆盖时长不因释放改变');

  // 备路段的 Blob/URL 仍可真实读取
  const live = h.par.segments[backup.index];
  assert.ok(live.blob && live.url);
  assert.equal(
    Buffer.from(await live.blob.arrayBuffer()).toString(),
    'BACKUP-DATA!!'
  );

  // 再释放备路：归零
  await h.par.releaseSegment(backup.index);
  assert.equal(h.par.heldBytes, 0);
  assert.ok(h.urlObj.revoked.includes(bUrl));

  // 越界/重复释放安全
  await h.par.releaseSegment(99);
  await h.par.releaseSegment(primary.index);
  assert.equal(h.par.heldBytes, 0);
});

test('替换后释放旧车道块：按归属路由到旧录制器，新车道素材完好', async () => {
  const h = makeHarness();
  await startBoth(h);
  const mrP0 = h.mrP();
  const mrB = h.mrB();
  h.clock.tick(1000);
  mrP0.emitChunk('OLD-P'); // 5
  mrB.emitChunk('BACKUP'); // 6

  const p = h.par.replace('primary', C);
  await flushMicrotasks(2);
  const mrC = h.mrC();
  await p;
  mrP0.fireStop();
  await flushMicrotasks();
  h.clock.tick(500);
  mrC.emitChunk('NEW-P'); // 5

  await h.par.stop();
  mrC.fireStop();
  mrB.fireStop();
  await flushMicrotasks();

  const segs = h.par.segments;
  const oldP = segs.find((s) => s.deviceId === P);
  const newP = segs.find((s) => s.deviceId === C);
  await h.par.releaseSegment(oldP.index); // 旧主块与新主块本地序号同为 0
  assert.equal(h.par.heldBytes, 11, '只释放旧主 5 字节（6+5 保留）');
  assert.equal(h.par.segments[newP.index].bytes, 5, '新主块完好');
  const manifest = h.par.buildManifest();
  assert.equal(manifest.deliverable, true);
});

test('合计容量：两路合并超限统一以 quota-limit 停止；单路不超但合计超也触发', async () => {
  const h = makeHarness({ maxHeldBytes: 20 });
  await startBoth(h);
  const mrP = h.mrP();
  const mrB = h.mrB();

  mrP.emitChunk('1234567890'); // 10：单路不超限（子路限制为 Infinity）
  await flushMicrotasks();
  assert.equal(h.par.running, true, '单路 10 < 合计上限 20');
  assert.ok(!h.events.some((e) => e.type === 'quotaexceeded'));

  mrB.emitChunk('123456789012'); // +12 = 22 > 20
  await flushMicrotasks();
  assert.ok(h.events.some((e) => e.type === 'quotaexceeded'));
  assert.equal(h.par.running, false, '超限统一停止两路');

  mrP.fireStop();
  mrB.fireStop();
  await flushMicrotasks();
  const reasons = h.par.buildManifest().segments.map((s) => s.endedReason);
  assert.ok(reasons.every((r) => r === 'quota-limit'));
});
