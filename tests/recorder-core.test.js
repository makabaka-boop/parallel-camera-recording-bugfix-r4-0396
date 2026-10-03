/**
 * recorder-core.test.js — 用可控媒体对象测试事件竞争与分段语义。
 *
 * 运行：node --test tests/recorder-core.test.js
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeClock,
  FakeMediaDevices,
  FakeMediaRecorder,
  FakeURL,
  flushMicrotasks
} from './fake-media.js';
import { Recorder, pickSupportedMimeType } from '../src/recorder-core.js';

const P = 'cam-primary';
const B = 'cam-backup';

function makeHarness(opts = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const mediaDevices = new FakeMediaDevices([
    { deviceId: P, label: 'Primary Cam' },
    { deviceId: B, label: 'Backup Cam' }
  ]);
  const urlObj = new FakeURL();
  /** @type {FakeMediaRecorder[]} */
  const recorders = [];
  const RealMR = FakeMediaRecorder;
  class MR extends RealMR {
    constructor(stream, o) {
      super(stream, o);
      recorders.push(this);
    }
  }
  MR.isTypeSupported = FakeMediaRecorder.isTypeSupported;
  MR.supportedType = FakeMediaRecorder.supportedType;

  const rec = new Recorder({
    mediaDevices,
    MediaRecorder: MR,
    urlObj,
    devices: { primaryId: P, backupId: B },
    maxHeldBytes: opts.maxHeldBytes ?? 1024,
    timeslice: 1000,
    stopTimeoutMs: 5000,
    clock: {
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (id) => clock.clearTimeout(id)
    },
    watchPermission: opts.watchPermission ?? true,
    watchDeviceChanges: true,
    audio: false
  });
  rec.setDeviceList(mediaDevices.devices);

  const events = [];
  for (const t of [
    'segmentstart', 'segmentsealing', 'segmentsealed',
    'forcedseal', 'failoverfailed', 'quotaexceeded', 'acquireerror'
  ]) {
    rec.addEventListener(t, (e) => events.push({ type: t, detail: e.detail }));
  }

  return {
    rec, clock, mediaDevices, urlObj, recorders, events,
    active: () => recorders[recorders.length - 1],
    first: () => recorders[0]
  };
}
async function started(h, role = 'primary') {
  await h.rec.start(role);
  await flushMicrotasks();
  return h.first();
}

/** 触发 stop 并补发 MediaRecorder 的异步 onstop，等封口落定。 */
async function sealAndStop(h, mr) {
  mr.fireStop();
  await flushMicrotasks();
}

beforeEach(() => {
  FakeMediaRecorder.constructError = null;
});

// ---------------------------------------------------------------------------

test('pickSupportedMimeType 选择受支持的类型', () => {
  assert.equal(pickSupportedMimeType(FakeMediaRecorder), FakeMediaRecorder.supportedType);
  assert.equal(pickSupportedMimeType({ isTypeSupported: () => false }), '');
  assert.equal(pickSupportedMimeType(undefined), '');
});

test('开始 → 数据块归段 → 停止 onstop → sealed Blob + URL', async () => {
  const h = makeHarness();
  const mr = await started(h);

  assert.equal(h.rec.running, true);
  assert.equal(h.rec.activeDeviceId, P);
  mr.emitChunk('AAAA');
  mr.emitChunk('BBBB');
  assert.equal(h.rec.heldBytes, 8);

  await h.rec.stop();
  assert.equal(h.rec.active, null, 'stop 后活动指针立即清空');
  // onstop 还没到：段处于 sealing，最终停止必须等它落定。
  assert.equal(h.rec.segments[0].state, 'sealing');

  let settled = false;
  h.rec.whenSettled().then(() => { settled = true; });
  await flushMicrotasks();
  assert.equal(settled, false, 'onstop 未到不能算落定');

  await sealAndStop(h, mr);
  assert.equal(settled, true);
  const seg = h.rec.segments[0];
  assert.equal(seg.state, 'sealed');
  assert.equal(seg.bytes, 8);
  assert.equal(Buffer.from(await seg.blob.arrayBuffer()).toString(), 'AAAABBBB');
  assert.ok(seg.url.startsWith('blob:fake/'));
  assert.equal(seg.reason, 'user-stop');
  assert.equal(h.rec.gaps.length, 0, '干净停止不产生缺口');
});

test('迟到块只能归属原片段：sealed 后再 emit 的块被丢弃', async () => {
  const h = makeHarness();
  const mr = await started(h);
  mr.emitChunk('1111');
  await h.rec.stop();
  await sealAndStop(h, mr);
  const seg = h.rec.segments[0];
  assert.equal(seg.state, 'sealed');
  assert.equal(seg.chunks.length, 0, '封口后 chunks 已固化');

  // ondataavailable 在 stop 之后非常晚才到：不能追加。
  mr.emitChunk('LATE-LATE');
  await flushMicrotasks();
  assert.equal(seg.bytes, 4, '迟到块不得进入已封口段');
  assert.equal(h.rec.heldBytes, 4, '迟到块不计入持有量');
});

test('旧 recorder 的迟到块不会写进接管后的新片段', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  mr1.emitChunk('PRIMARY-DATA');

  // 主设备轨道结束（热拔出）→ 段1封口 + 缺口 + 备机新片段
  const primaryTrack = h.mediaDevices.activeStreams.get(P).getVideoTracks()[0];
  primaryTrack.simulateEnded();
  await flushMicrotasks();
  assert.equal(h.rec.segments[0].state, 'sealing');

  // 新片段在备机上起来（段1 onstop 故意还没补发，制造交错）
  await flushMicrotasks();
  const mr2 = h.active();
  assert.notEqual(mr1, mr2);
  assert.equal(h.rec.activeDeviceId, B);
  assert.equal(h.rec.segments[1].state, 'recording');

  // 旧 recorder 此刻才吐出迟到块 + onstop：只能进段0
  mr1.emitChunk('OLD-LATE-CHUNK');
  mr1.fireStop();
  await flushMicrotasks();

  assert.equal(h.rec.segments[0].state, 'sealed');
  assert.equal(
    Buffer.from(await h.rec.segments[0].blob.arrayBuffer()).toString(),
    'PRIMARY-DATAOLD-LATE-CHUNK',
    '迟到块归属原片段（段0）'
  );

  mr2.emitChunk('BACKUP-DATA');
  // 段1的累积只应包含它自己的数据（旧 recorder 的迟到块没有串过来）
  const seg1Bytes = Buffer.concat(
    await Promise.all(h.rec.segments[1].chunks.map(async (c) =>
      Buffer.from(await c.arrayBuffer())
    ))
  ).toString();
  assert.equal(seg1Bytes, 'BACKUP-DATA');

  await h.rec.stop();
  mr2.fireStop();
  await flushMicrotasks();

  assert.equal(h.rec.segments.length, 2);
  assert.equal(h.rec.gaps.length, 1);
  const g = h.rec.gaps[0];
  assert.equal(g.reason, 'disconnect');
  assert.equal(g.afterSegment, 0);
  assert.ok(g.to >= g.from, '缺口在新片段开始时闭合');
  // 两段是独立 Blob，绝不合并
  assert.notEqual(h.rec.segments[0].url, h.rec.segments[1].url);
});

test('手动切换：明确结束当前段 + switch 缺口 + 新设备新片段', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  h.clock.tick(1000);
  mr1.emitChunk('A');
  await h.rec.switchTo('backup');
  await flushMicrotasks();
  // 段0 onstop 在切换流程中尚未补发
  assert.equal(h.rec.segments[0].state, 'sealing');
  mr1.fireStop();
  await flushMicrotasks();

  const mr2 = h.active();
  assert.equal(h.rec.activeDeviceId, B);
  assert.equal(h.rec.segments[0].reason, 'manual-switch');
  assert.equal(h.rec.gaps[0].reason, 'switch');
  assert.equal(h.rec.gaps[0].from, h.rec.segments[0].endedAt);

  h.clock.tick(2000);
  mr2.emitChunk('B');
  await h.rec.switchTo('primary');
  await flushMicrotasks();
  mr2.fireStop();
  await flushMicrotasks();

  assert.equal(h.rec.segments.length, 3, '主→备→主产生 3 个独立片段');
  assert.equal(h.rec.gaps.length, 2);
  assert.equal(h.rec.segments[2].deviceId, P);
});

test('主设备拔出且备机可用：从新片段继续，清单记录设备/起止/缺口', async () => {
  const h = makeHarness();
  h.mediaDevices.onAcquireDelay = async (id) => {
    // 备机打开耗时 300ms（驱动加载等），形成真实缺口
    if (id === B) h.clock.tick(300);
  };
  const mr1 = await started(h);
  const t0 = h.clock.now();
  h.clock.tick(1500);
  mr1.emitChunk('X');

  const track = h.mediaDevices.activeStreams.get(P).getVideoTracks()[0];
  track.simulateEnded(); // 真实拔出：readyState=ended + ended 事件
  await flushMicrotasks();

  const mr2 = h.active();
  assert.equal(h.rec.activeDeviceId, B, '自动接管到备机');
  assert.equal(h.rec.segments.length, 2);
  assert.equal(h.rec.segments[1].role, 'backup');

  const gap = h.rec.gaps[0];
  assert.equal(gap.from, t0 + 1500);
  assert.equal(gap.to, t0 + 1500 + 300);
  assert.equal(gap.to - gap.from, 300);

  mr2.emitChunk('Y');
  await h.rec.stop();
  mr1.fireStop();
  mr2.fireStop();
  await flushMicrotasks();

  const manifest = h.rec.buildManifest();
  assert.equal(manifest.segments.length, 2);
  assert.equal(manifest.segments[0].deviceId, P);
  assert.equal(manifest.segments[0].role, 'primary');
  assert.equal(manifest.segments[0].endedReason, 'ended');
  assert.ok(manifest.segments[0].startedAt);
  assert.ok(manifest.segments[0].endedAt);
  assert.equal(manifest.segments[1].deviceId, B);
  assert.equal(manifest.gaps.length, 1);
  assert.equal(manifest.gaps[0].durationMs, 300);
  assert.equal(manifest.sealedCount, 2);
});

test('热插拔兜底：devicechange 发现当前设备消失也触发接管', async () => {
  const h = makeHarness();
  await started(h);
  // 平台不发 track.ended 的极端情况：仅设备列表变化
  h.mediaDevices.removeDeviceNoEvent(P);
  h.mediaDevices.emitDeviceChange();
  await flushMicrotasks();
  assert.equal(h.rec.activeDeviceId, B);
  assert.equal(h.rec.gaps[0].reason, 'disconnect');
});

test('两台都不可用：当前片段结束，缺口保持打开(failoverFailed)，录制终止', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  h.mediaDevices.failures.set(B, 'throw'); // 备机也打不开

  h.mediaDevices.activeStreams.get(P).getVideoTracks()[0].simulateEnded();
  await flushMicrotasks();

  assert.equal(h.rec.running, false);
  assert.equal(h.rec.segments[0].state, 'sealing');
  const gap = h.rec.gaps[0];
  assert.equal(gap.to, null, '缺口未闭合');
  assert.equal(gap.failoverFailed, true);
  assert.equal(gap.reason, 'disconnect', '保留原始中断原因');

  mr1.fireStop();
  await flushMicrotasks();
  const manifest = h.rec.buildManifest();
  assert.equal(manifest.gaps[0].open, true);
  assert.equal(manifest.gaps[0].failoverFailed, true);
});

test('轨道静音(mute)：切段、缺口原因=mute，备机接管', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  h.mediaDevices.activeStreams.get(P).getVideoTracks()[0].simulateMute();
  await flushMicrotasks();
  assert.equal(h.rec.activeDeviceId, B);
  assert.equal(h.rec.gaps[0].reason, 'mute');
  assert.equal(h.rec.segments[0].reason, 'mute');

  await h.rec.stop();
  mr1.fireStop();
  h.recorders[1].fireStop();
  await flushMicrotasks();
});

test('权限失效：当前段结束；备机可获取则新段继续', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  h.clock.tick(500);
  h.mediaDevices.permissionStatus.setState('denied');
  await flushMicrotasks();

  assert.equal(h.rec.activeDeviceId, B);
  assert.equal(h.rec.gaps[0].reason, 'permission');
  assert.equal(h.rec.segments[0].reason, 'permission');

  await h.rec.stop();
  mr1.fireStop();
  h.recorders[1].fireStop();
  await flushMicrotasks();
  assert.equal(h.rec.segments.length, 2);
});

test('权限失效且两台都拿不到：权限缺口打开并终止', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  h.mediaDevices.failures.set(P, 'deny');
  h.mediaDevices.failures.set(B, 'deny');
  h.mediaDevices.permissionStatus.setState('denied');
  await flushMicrotasks();

  assert.equal(h.rec.running, false);
  assert.equal(h.rec.gaps[0].reason, 'permission');
  assert.equal(h.rec.gaps[0].to, null);
  assert.equal(h.rec.gaps[0].failoverFailed, true);
  mr1.fireStop();
  await flushMicrotasks();
});

test('MediaRecorder onerror：封口并尝试接管', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  mr1.fireError('codec exploded');
  await flushMicrotasks();
  assert.equal(h.rec.activeDeviceId, B);
  assert.equal(h.rec.gaps[0].reason, 'recorder-error');
  const mr2 = h.active();

  await h.rec.stop();
  mr1.fireStop();
  mr2.fireStop();
  await flushMicrotasks();
  assert.equal(h.rec.segments.length, 2);
});

test('stop 与设备拔出竞争 A：先 stop 后收到 track.ended，不接管、不开新片段', async () => {
  const h = makeHarness();
  const mr1 = await started(h);

  // 用户停止先入队；紧接着轨道 ended 到达（它只能排在 stop 任务之后）。
  const stopP = h.rec.stop();
  h.mediaDevices.activeStreams.get(P).getVideoTracks()[0].simulateEnded();
  await flushMicrotasks();
  await stopP;

  assert.equal(h.rec.segments.length, 1, '停止后不能再追加/新建片段');
  assert.equal(h.rec.running, false);
  assert.equal(h.rec.gaps.length, 0, '干净停止不产生缺口');
  assert.equal(h.rec.segments[0].reason, 'user-stop');
  mr1.fireStop();
  await flushMicrotasks();
  assert.equal(h.rec.segments[0].state, 'sealed');
});

test('stop 与设备拔出竞争 B：接管任务已在采集 await 中，随后停止，迟到流被释放', async () => {
  const h = makeHarness();
  const mr1 = await started(h);

  // ended 任务先入队并在“打开备机”的 await 中挂起；此时用户停止。
  let releaseBackup;
  h.mediaDevices.onAcquireDelay = (id) => {
    if (id === B) return new Promise((res) => { releaseBackup = res; });
  };
  h.mediaDevices.activeStreams.get(P).getVideoTracks()[0].simulateEnded();
  await flushMicrotasks(2); // 让 ended 任务跑到 await getUserMedia(B)
  const stopP = h.rec.stop();
  await flushMicrotasks(2);
  releaseBackup(); // 备机流迟到
  await stopP;
  await flushMicrotasks();

  assert.equal(h.rec.segments.length, 1, '迟到的备机流不得新建片段');
  assert.equal(h.rec.gaps.length, 1, '中断本身产生了缺口');
  assert.equal(h.rec.gaps[0].failoverFailed, true, '接管因停止而作废');
  const backupStream = h.mediaDevices.activeStreams.get(B);
  assert.ok(
    backupStream.getTracks().every((t) => t.readyState === 'ended'),
    '迟到的备机流轨道必须立即停止释放'
  );
});

test('重复/幂等：同一轨道连发两次 ended 只切一次', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  const track = h.mediaDevices.activeStreams.get(P).getVideoTracks()[0];
  track.simulateEnded();
  track.dispatchEvent(new Event('ended')); // 再来一次
  track.dispatchEvent(new Event('ended'));
  await flushMicrotasks();
  assert.equal(h.rec.segments.length, 2, '只产生一个接管片段');
  assert.equal(h.rec.gaps.length, 1);
});

test('停止后迟到的 ondataavailable/onstop 不产生任何新数据', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  mr1.emitChunk('GOOD');
  await h.rec.stop();
  mr1.fireStop();
  await flushMicrotasks();
  const bytes = h.rec.heldBytes;

  mr1.fireStop();          // 重复 onstop
  mr1.emitChunk('NOPE');   // 极迟到块
  await flushMicrotasks();
  assert.equal(h.rec.heldBytes, bytes);
  assert.equal(h.rec.segments.length, 1);
});

test('配额：持有量超限自动以 quota-limit 封口并停止', async () => {
  const h = makeHarness({ maxHeldBytes: 10 });
  const mr1 = await started(h);
  mr1.emitChunk('12345');           // 5
  mr1.emitChunk('123456');          // +6 = 11 > 10
  await flushMicrotasks();
  assert.equal(h.rec.running, false);
  assert.equal(h.rec.segments[0].state, 'sealing');
  assert.equal(h.rec.segments[0].reason, 'quota-limit');
  assert.ok(h.events.some((e) => e.type === 'quotaexceeded'));
  mr1.fireStop();
  await flushMicrotasks();
});

test('watchdog：onstop 永不到达时超时强制封口', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  mr1.emitChunk('DATA');
  await h.rec.stop();
  assert.equal(h.clock.pendingTimers(), 1);

  h.clock.tick(4999);
  await flushMicrotasks();
  assert.equal(h.rec.segments[0].state, 'sealing', '超时前仍在封口');
  h.clock.tick(2); // 5001ms
  await flushMicrotasks(); // 看门狗回调经 enqueue 入队，需要排空微任务
  assert.equal(h.rec.segments[0].state, 'sealed', '看门狗强制封口');
  assert.equal(h.rec.segments[0].reason, 'user-stop+stop-timeout');
  assert.equal(h.rec.segments[0].bytes, 4);
});

test('强制封口后 onstop 才迟到：忽略，不重开段', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  await h.rec.stop();
  h.clock.tick(5001); // 强制封口
  await flushMicrotasks();
  assert.equal(h.rec.segments[0].state, 'sealed');
  mr1.emitChunk('LATE');
  mr1.fireStop(); // 迟到的 onstop
  await flushMicrotasks();
  assert.equal(h.rec.segments[0].bytes, 0);
});

test('releaseSegment：撤销 URL、扣减持有量', async () => {
  const h = makeHarness();
  const mr = await started(h);
  mr.emitChunk('ABC');
  await h.rec.stop();
  mr.fireStop();
  await flushMicrotasks();
  const url = h.rec.segments[0].url;
  await h.rec.releaseSegment(0);
  assert.ok(h.urlObj.revoked.includes(url));
  assert.equal(h.rec.heldBytes, 0);
  assert.equal(h.rec.segments[0].released, true);
});

test('dispose：撤销全部 ObjectURL、停止轨道、解除监听', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  mr1.emitChunk('X');
  await h.rec.switchTo('backup');
  await flushMicrotasks();
  const mr2 = h.active();
  mr2.emitChunk('Y');
  mr1.fireStop();
  await flushMicrotasks();
  const urls = h.rec.segments.map((s) => s.url).filter(Boolean);
  const liveTracks = [
    ...h.mediaDevices.activeStreams.get(P).getTracks(),
    ...h.mediaDevices.activeStreams.get(B).getTracks()
  ];

  await h.rec.dispose();
  mr2.fireStop(); // dispose 后迟到
  await flushMicrotasks();

  for (const u of urls) assert.ok(h.urlObj.revoked.includes(u), `${u} 已撤销`);
  assert.ok(liveTracks.every((t) => t.readyState === 'ended'));
});

test('await getUserMedia 期间用户停止：迟到的流被立即释放，不成段', async () => {
  const h = makeHarness();
  let releaseGate;
  h.mediaDevices.onAcquireDelay = () =>
    new Promise((res) => { releaseGate = res; });

  const startP = h.rec.start('primary');
  await flushMicrotasks(2);
  // getUserMedia 挂起时用户停止
  const stopP = h.rec.stop();
  await flushMicrotasks(2);
  releaseGate();
  await startP;
  await stopP;
  await flushMicrotasks();

  assert.equal(h.rec.running, false);
  // start 里 running 初始为 false，_beginSegment 成功后发现 !running 会释放流
  const stream = h.mediaDevices.activeStreams.get(P);
  assert.ok(stream.getTracks().every((t) => t.readyState === 'ended'));
});

test('start 时主设备不可用但备机在：start 失败显式报错，不伪装录制', async () => {
  const h = makeHarness();
  h.mediaDevices.failures.set(P, 'deny');
  await h.rec.start('primary');
  await flushMicrotasks();
  assert.equal(h.rec.running, false);
  assert.equal(h.rec.segments.length, 0);
  assert.ok(h.events.some((e) => e.type === 'acquireerror'));
});

test('手动切换目标打不开：自动回退另一台，不丢录制', async () => {
  const h = makeHarness();
  const mr1 = await started(h);
  h.mediaDevices.failures.set(B, 'throw');
  // 主在录，要求切备；备打不开 -> 回退只能还是主（同设备时 _switchTo 已去重，
  // 这里构造 主→备 失败后尝试主：会新开一段主机片段）
  await h.rec.switchTo('backup');
  await flushMicrotasks();
  assert.equal(h.rec.running, true);
  assert.equal(h.rec.activeDeviceId, P, '回退到主机继续');
  assert.equal(h.rec.segments.length, 2);
  assert.equal(h.rec.gaps.length, 1, '切换仍留下明确缺口');
});
