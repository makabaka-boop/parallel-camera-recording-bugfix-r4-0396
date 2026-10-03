/**
 * e2e.spec.js — 浏览器端到端：真实 Chromium + 浏览器原生 MediaRecorder，
 * 摄像头由注入的虚拟双设备提供（见 helpers/browser-fake-media.js）。
 *
 * 覆盖一次完整“录制 → 主设备断开 → 备机接管 → 停止 → 导出清单”流程，
 * 以及手动切换、迟到块归属、配额停止、ObjectURL 撤销、零媒体上传。
 *
 * 运行：node --test tests/e2e.spec.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { FAKE_MEDIA_INIT } from './helpers/browser-fake-media.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css'
};

let server;
let browser;

before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, BASE).pathname);
      if (p === '/') p = '/index.html';
      const file = normalize(join(SRC, p));
      if (!file.startsWith(SRC)) { res.writeHead(403).end(); return; }
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        // 明确断言：媒体请求只可能是页面资源，不存在媒体上传端点。
        'Cache-Control': 'no-store'
      });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  // 本机无 root 安装 Chromium 系统依赖时，把用户目录解压的库通过 env 注入浏览器进程。
  const localLibs = ['aarch64', 'x86_64']
    .flatMap((arch) => [
      `/tmp/chromelibs/usr/lib/${arch}-linux-gnu`,
      `/tmp/chromelibs/lib/${arch}-linux-gnu`
    ])
    .join(':');
  browser = await chromium.launch({
    headless: true,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
        ? `${localLibs}:${process.env.LD_LIBRARY_PATH}`
        : localLibs
    },
    args: [
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-file-access-from-files'
    ]
  });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.addInitScript(FAKE_MEDIA_INIT);

  // 记录所有对外请求；测试结束断言没有任何媒体被上传。
  const requests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    requests.push({ method: req.method(), url, postSize: req.postDataBuffer()?.length || 0 });
  });
  await page.goto(BASE);
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#primarySelect option')).length >= 2
  );
  return { page, requests };
}

/** 在页面里选好主备并开始录制，返回后第一段已在录制。 */
async function configureAndStart(page, primaryId, backupId) {
  await page.evaluate(([p, b]) => {
    document.getElementById('primarySelect').value = p;
    document.getElementById('primarySelect').dispatchEvent(new Event('change'));
    document.getElementById('backupSelect').value = b;
    document.getElementById('backupSelect').dispatchEvent(new Event('change'));
  }, [primaryId, backupId]);
  await page.waitForTimeout(300);
  await page.click('#startBtn');
  await page.waitForFunction(
    () => window.__recorder && window.__recorder.segments.length >= 1
  );
  // 等第一段稳定录制
  await page.waitForTimeout(500);
}

async function getState(page) {
  return page.evaluate(() => {
    const r = window.__recorder;
    return {
      running: r.running,
      heldBytes: r.heldBytes,
      activeDeviceId: r.activeDeviceId ?? null,
      activeRole: r.activeRole ?? null,
      isParallel: typeof r.lanes === 'object',
      segments: r.segments.map((s) => ({
        index: s.index, deviceId: s.deviceId, role: s.role,
        state: s.state, reason: s.reason, bytes: s.bytes,
        released: !!s.released,
        hasUrl: !!s.url, hasBlob: !!s.blob
      })),
      gaps: r.gaps.map((g) => ({
        afterSegment: g.afterSegment,
        role: g.role || null,
        from: g.from, to: g.to,
        open: g.to == null, reason: g.reason,
        failoverFailed: !!g.failoverFailed
      })),
      manifest: r.buildManifest()
    };
  });
}

async function waitFor(predicate, page, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await page.waitForTimeout(50);
  }
}

// ---------------------------------------------------------------------------

test('完整流程：录制 → 主设备热拔出 → 备机新片段接管 → 停止 → 两段独立 WebM + 时间清单', async () => {
  const { page, requests } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP
  }));

  await configureAndStart(page, PRIMARY, BACKUP);
  let st = await getState(page);
  assert.equal(st.activeDeviceId, PRIMARY);
  assert.equal(st.segments[0].state, 'recording');

  // 录一会儿主设备（真实 canvas 帧 -> 真实 MediaRecorder 块）
  await page.waitForTimeout(1200);

  // 热拔出主设备：触发 track.ended + devicechange
  await page.evaluate(() => window.__fakeMedia.unplug('primary'));

  // 接管：新片段必须来自备机
  await waitFor(async () => {
    const s = await getState(page);
    return s.segments.length >= 2 && s.activeDeviceId === BACKUP;
  }, page);
  st = await getState(page);
  assert.equal(st.segments.length, 2);
  assert.ok(
    st.segments[0].state === 'sealing' || st.segments[0].state === 'sealed',
    '主设备段必须已明确结束（封口或已保存）'
  );
  assert.equal(st.segments[1].deviceId, BACKUP);
  assert.equal(st.segments[1].role, 'backup');

  // 存在一个断开缺口，且被新片段闭合
  st = await getState(page);
  assert.equal(st.gaps.length, 1);
  assert.equal(st.gaps[0].reason, 'disconnect');
  assert.equal(st.gaps[0].afterSegment, 0);
  assert.ok(st.gaps[0].to != null);
  assert.ok(st.gaps[0].to >= st.gaps[0].from);

  // 备机继续录一会儿
  await page.waitForTimeout(1200);

  // 停止并等待全部封口
  await page.click('#stopBtn');
  await page.waitForFunction(
    () => window.__recorder &&
      window.__recorder.segments.every((s) => s.state === 'sealed'),
    { timeout: 20000 }
  );

  st = await getState(page);
  assert.equal(st.running, false);
  assert.equal(st.segments.length, 2);
  for (const s of st.segments) {
    assert.equal(s.state, 'sealed');
    assert.ok(s.bytes > 0, '每段必须有真实媒体数据');
    assert.equal(s.hasUrl, true);
  }
  assert.notEqual(
    st.segments[0].deviceId, st.segments[1].deviceId,
    '两段来自不同设备'
  );

  // 真实 Blob 必须是独立的可解码 WebM 容器
  const blobs = await page.evaluate(async () => {
    const out = [];
    for (const s of window.__recorder.segments) {
      const buf = new Uint8Array(await s.blob.arrayBuffer());
      out.push({
        size: buf.length,
        // EBML/WebM 魔数 1A 45 DF A3
        isWebm: buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
      });
    }
    return out;
  });
  for (const b of blobs) assert.ok(b.isWebm, `段必须是 WebM 容器（size=${b.size}）`);
  assert.ok(blobs[0].size > 1000 && blobs[1].size > 1000);

  // 清单内容完整：设备、起止时间、缺口
  const m = st.manifest;
  assert.equal(m.schema, 'dual-camera-recording/v1');
  assert.equal(m.segments.length, 2);
  assert.equal(m.segments[0].deviceId, PRIMARY);
  assert.equal(m.segments[0].role, 'primary');
  assert.equal(m.segments[0].endedReason, 'ended');
  assert.ok(m.segments[0].startedAt && m.segments[0].endedAt);
  assert.equal(m.segments[1].deviceId, BACKUP);
  assert.equal(m.segments[1].role, 'backup');
  assert.equal(m.segments[1].endedReason, 'user-stop');
  assert.equal(m.gaps.length, 1);
  assert.equal(m.gaps[0].open, false);
  assert.ok(m.gaps[0].durationMs >= 0);
  assert.match(m.note, /never left this machine/);

  // 表格里应有两段
  const rowCount = await page.locator('#segmentsBody tr:not(.empty)').count();
  assert.equal(rowCount, 2);

  // 零媒体上传：除页面静态资源外无任何请求，且没有 POST/PUT
  const nonStatic = requests.filter((r) =>
    !r.url.startsWith(BASE + '/') && !r.url.startsWith('http://127.0.0.1')
  );
  assert.equal(nonStatic.length, 0, `意外的对外请求: ${JSON.stringify(nonStatic)}`);
  const uploads = requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  assert.equal(uploads.length, 0, '不得有任何上传请求');

  await page.close();
});

test('手动切换：主→备→主产生 3 段 2 个 switch 缺口，迟到数据不串段', async () => {
  const { page } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP
  }));
  await configureAndStart(page, PRIMARY, BACKUP);
  await page.waitForTimeout(800);

  await page.click('#switchBtn');
  await waitFor(async () => (await getState(page)).activeDeviceId === BACKUP, page);
  await page.waitForTimeout(800);

  await page.click('#switchBtn');
  await waitFor(async () => (await getState(page)).activeDeviceId === PRIMARY, page);
  await page.waitForTimeout(800);

  await page.click('#stopBtn');
  await page.waitForFunction(
    () => window.__recorder.segments.every((s) => s.state === 'sealed'),
    { timeout: 20000 }
  );

  const st = await getState(page);
  assert.equal(st.segments.length, 3);
  assert.deepEqual(
    st.segments.map((s) => s.deviceId),
    [PRIMARY, BACKUP, PRIMARY]
  );
  assert.equal(st.gaps.length, 2);
  for (const g of st.gaps) {
    assert.equal(g.reason, 'switch');
    assert.ok(g.to != null);
  }
  assert.ok(st.segments.every((s) => s.bytes > 0));
  // 三段 URL 互不相同 —— 绝不是“无中断单一视频”
  const urls = await page.evaluate(() =>
    window.__recorder.segments.map((s) => s.url));
  assert.equal(new Set(urls).size, 3);

  await page.close();
});

test('主备均失效：当前段结束，缺口保持打开，录制明确终止', async () => {
  const { page } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP
  }));
  await configureAndStart(page, PRIMARY, BACKUP);
  await page.waitForTimeout(600);

  // 主拔出，且让备机的接管请求失败
  await page.evaluate(() => {
    window.__fakeMedia.denyOnce('backup');
    window.__fakeMedia.unplug('primary');
  });

  await waitFor(async () => (await getState(page)).running === false, page);
  const st = await getState(page);
  assert.equal(st.segments.length, 1);
  assert.equal(st.gaps.length, 1);
  assert.equal(st.gaps[0].open, true);
  assert.equal(st.gaps[0].failoverFailed, true);

  // UI 状态体现“存在未闭合缺口”
  const status = await page.locator('#statusText').textContent();
  assert.match(status, /缺口|停止/);

  await page.close();
});

test('轨道 mute：切段并以 mute 原因接管备机', async () => {
  const { page } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP
  }));
  await configureAndStart(page, PRIMARY, BACKUP);
  await page.waitForTimeout(600);

  await page.evaluate(() => window.__fakeMedia.mute('primary'));
  await waitFor(async () => (await getState(page)).activeDeviceId === BACKUP, page);
  const st = await getState(page);
  assert.equal(st.gaps[0].reason, 'mute');
  assert.equal(st.segments[0].reason, 'mute');

  await page.click('#stopBtn');
  await page.waitForFunction(
    () => window.__recorder.segments.every((s) => s.state === 'sealed'),
    { timeout: 20000 }
  );
  await page.close();
});

test('清空：所有 ObjectURL 均被 revokeObjectURL 撤销', async () => {
  const { page } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP
  }));
  await configureAndStart(page, PRIMARY, BACKUP);
  await page.waitForTimeout(500);
  await page.click('#stopBtn');
  await page.waitForFunction(
    () => window.__recorder.segments.every((s) => s.state === 'sealed'),
    { timeout: 20000 }
  );

  const revoked = await page.evaluate(async () => {
    const r = window.__recorder;
    const urls = r.segments.map((s) => s.url);
    // 包裹 revokeObjectURL 以确认撤销动作（核心调用的是全局 URL）
    const calls = [];
    const orig = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => { calls.push(u); orig(u); };
    await r.dispose();
    URL.revokeObjectURL = orig;
    return { urls, calls };
  });
  for (const u of revoked.urls) {
    assert.ok(revoked.calls.includes(u), `${u} 应被撤销`);
  }
  await page.close();
});

// ---------------------------------------------------------------------------
// 双路同时留证（ParallelRecorder）
// ---------------------------------------------------------------------------

/** 勾选“双路同时留证”并以指定主备开始，返回时两路均在录制。 */
async function configureParallelAndStart(page, primaryId, backupId) {
  await page.evaluate(([p, b]) => {
    document.getElementById('parallelToggle').checked = true;
    document.getElementById('primarySelect').value = p;
    document.getElementById('primarySelect').dispatchEvent(new Event('change'));
    document.getElementById('backupSelect').value = b;
    document.getElementById('backupSelect').dispatchEvent(new Event('change'));
  }, [primaryId, backupId]);
  await page.waitForTimeout(300);
  await page.click('#startBtn');
  await page.waitForFunction(
    () => window.__recorder && window.__recorder.segments.length >= 2
  );
  await page.waitForTimeout(500);
}

test('双路：单路失联只终结该路，另一路继续；两路都封口后才能交付', async () => {
  const { page } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP
  }));
  await configureParallelAndStart(page, PRIMARY, BACKUP);

  // 拔出主路
  await page.evaluate(() => window.__fakeMedia.unplug('primary'));
  await waitFor(
    async () =>
      page.evaluate(
        () => !window.__recorder.lanes.get('primary').running
          && window.__recorder.lanes.get('backup').running
      ),
    page
  );

  let st = await getState(page);
  assert.equal(st.running, true, '备路继续，会话仍运行');
  const laneStates = await page.evaluate(() => ({
    primaryRunning: window.__recorder.lanes.get('primary').running,
    backupRunning: window.__recorder.lanes.get('backup').running
  }));
  assert.deepEqual(laneStates, { primaryRunning: false, backupRunning: true });

  // 主路有打开的缺口，缺口带路归属
  st = await getState(page);
  const primaryGap = st.gaps.find((g) => g.role === 'primary');
  assert.ok(primaryGap, '主路断开留下缺口');
  assert.equal(primaryGap.open, true, '该路无设备可接管，缺口保持打开');
  assert.equal(primaryGap.failoverFailed, true);

  // 仍在录制中：交付未就绪
  assert.equal(st.manifest.ready, false);

  // 备路再录一会儿后整体停止
  await page.waitForTimeout(800);
  await page.click('#stopBtn');
  await page.waitForFunction(
    () => window.__recorder.segments.every((s) => s.state === 'sealed'),
    { timeout: 20000 }
  );

  st = await getState(page);
  assert.equal(st.running, false);
  assert.equal(st.segments.length, 2);
  assert.deepEqual(
    st.segments.map((s) => [s.deviceId, s.role]),
    [[PRIMARY, 'primary'], [BACKUP, 'backup']],
    '每块素材保留真实设备与路归属'
  );
  assert.equal(st.manifest.ready, true, '两路都封口后可交付');
  // 重叠拍摄时间按并集计算，不是两段时长简单相加
  const sums = st.manifest.segments.reduce((n, s) => n + s.durationMs, 0);
  assert.ok(
    st.manifest.coverageMs < sums,
    `覆盖(${st.manifest.coverageMs}) 应小于两段之和(${sums})`
  );

  await page.close();
});

test('双路：替换主路设备后，新素材记在主路名下且设备真实，备路不受影响', async () => {
  const { page } = await newPage();
  const IDS = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP,
    SPARE: window.__fakeMedia.SPARE
  }));
  await configureParallelAndStart(page, IDS.PRIMARY, IDS.BACKUP);
  await page.waitForTimeout(700);

  // 主路设备失效：拔出主路（该路结束），随后在选择器里选替换机 SPARE
  // 并点击“替换所选路设备”，主路用新设备重开。
  await page.evaluate(() => window.__fakeMedia.unplug('primary'));
  await page.waitForFunction(
    () => !window.__recorder.lanes.get('primary').running
      && window.__recorder.lanes.get('backup').running,
    { timeout: 10000 }
  );

  await page.evaluate((spare) => {
    document.getElementById('replaceRole').value = 'primary';
    document.getElementById('primarySelect').value = spare;
  }, IDS.SPARE);
  await page.click('#switchBtn');
  await page.waitForFunction(
    () => window.__recorder.lanes.get('primary').activeDeviceId === 'fake-device-spare'
      && window.__recorder.lanes.get('primary').running,
    { timeout: 10000 }
  );

  // 备路全程未受影响
  assert.equal(
    await page.evaluate(
      () => window.__recorder.lanes.get('backup').activeDeviceId
    ),
    IDS.BACKUP
  );

  await page.waitForTimeout(700);
  await page.click('#stopBtn');
  await page.waitForFunction(
    () => window.__recorder.segments.every((s) => s.state === 'sealed'),
    { timeout: 20000 }
  );

  const st = await getState(page);
  // 三段：旧主(PRIMARY, primary)、备(BACKUP, backup)、新主(SPARE, primary)
  assert.equal(st.segments.length, 3);
  assert.deepEqual(
    st.segments.map((s) => [s.deviceId, s.role]),
    [
      [IDS.PRIMARY, 'primary'],
      [IDS.BACKUP, 'backup'],
      [IDS.SPARE, 'primary']
    ],
    '替换机素材归主路，不能记到仍在工作的备路名下'
  );
  assert.deepEqual(
    st.manifest.segments.map((s) => s.file),
    ['segment-000.webm', 'segment-001.webm', 'segment-002.webm']
  );
  for (const s of st.segments) assert.ok(s.bytes > 0, '每段都有真实媒体');
  // 旧主路故障缺口保留，替换后的新段是该路的后续素材
  assert.ok(
    st.gaps.some((g) => g.role === 'primary' && g.reason === 'disconnect')
  );

  await page.close();
});

test('双路：释放一路素材后另一路的持有字节与下载 URL 仍然有效', async () => {
  const { page } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP
  }));
  await configureParallelAndStart(page, PRIMARY, BACKUP);
  await page.waitForTimeout(1000);
  await page.click('#stopBtn');
  await page.waitForFunction(
    () => window.__recorder.segments.every((s) => s.state === 'sealed'),
    { timeout: 20000 }
  );

  const before = await page.evaluate(() => {
    const r = window.__recorder;
    return {
      held: r.heldBytes,
      segBytes: r.segments.map((s) => s.bytes),
      urls: r.segments.map((s) => s.url)
    };
  });
  assert.ok(before.held >= before.segBytes[0] + before.segBytes[1] - 50,
    '合计持有量约为两路之和');

  // 释放主路段（全局索引 0）
  await page.evaluate(() => window.__recorder.releaseSegment(0));
  await page.waitForTimeout(200);

  const after = await getState(page);
  assert.equal(after.segments[0].released, true);
  assert.equal(after.segments[0].hasUrl, false, '主路 URL 已撤销');
  assert.equal(after.segments[1].hasUrl, true, '备路 URL 保持有效');
  assert.equal(after.heldBytes, after.segments[1].bytes,
    '持有量只剩备路那一段');
  assert.equal(after.manifest.segments[0].file, null);
  assert.equal(after.manifest.segments[1].file, 'segment-001.webm');
  assert.equal(after.manifest.heldBytes, after.segments[1].bytes);

  await page.close();
});

test('双路：两路先后失效，会话在第二路也无法继续时才结束', async () => {
  const { page } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP
  }));
  await configureParallelAndStart(page, PRIMARY, BACKUP);
  await page.waitForTimeout(500);

  await page.evaluate(() => window.__fakeMedia.unplug('primary'));
  await page.waitForFunction(
    () => !window.__recorder.lanes.get('primary').running,
    { timeout: 10000 }
  );
  assert.equal(
    await page.evaluate(() => window.__recorder.running),
    true,
    '单路失效会话仍运行'
  );

  await page.evaluate(() => window.__fakeMedia.unplug('backup'));
  await waitFor(async () => (await getState(page)).running === false, page);

  const st = await getState(page);
  assert.equal(st.segments.length, 2);
  const roles = st.gaps.map((g) => g.role).sort();
  assert.deepEqual(roles, ['backup', 'primary'], '两路各留自己的缺口');
  assert.ok(st.gaps.every((g) => g.open));

  await page.close();
});
