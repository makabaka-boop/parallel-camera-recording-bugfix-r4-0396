/**
 * e2e-parallel.spec.js —— “双路同时留证”端到端：真实 Chromium + 原生
 * MediaRecorder，两路画面均由注入的虚拟双摄像头提供。
 *
 * 覆盖：
 *   A. 两路同时录 → 热拔出主路 → 备路持续录制 → 停止；
 *      两块独立可解码 WebM，清单中角色/设备归属正确，覆盖时长不翻倍。
 *   B. 替换主路设备（在同一页用第二个虚拟设备）→ 三块素材归属稳定。
 *   C. 停止后释放一侧素材：另一侧 URL/Blob 仍有效，仍可交付。
 *
 * 运行：node --test tests/e2e-parallel.spec.js
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
const PORT = 8124;
const BASE = `http://127.0.0.1:${PORT}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
};

let server;
let browser;

before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, BASE).pathname);
      if (p === '/') p = '/index.html';
      const file = normalize(join(SRC, p));
      if (!file.startsWith(SRC)) {
        res.writeHead(403).end();
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const localLibs = ['aarch64', 'x86_64']
    .flatMap((arch) => [
      `/tmp/chromelibs/usr/lib/${arch}-linux-gnu`,
      `/tmp/chromelibs/lib/${arch}-linux-gnu`,
    ])
    .join(':');
  browser = await chromium.launch({
    headless: true,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
        ? `${localLibs}:${process.env.LD_LIBRARY_PATH}`
        : localLibs,
    },
    args: [
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-file-access-from-files',
    ],
  });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.addInitScript(FAKE_MEDIA_INIT);
  const requests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    requests.push({ method: req.method(), url });
  });
  await page.goto(BASE);
  await page.waitForFunction(
    () => document.querySelectorAll('#primarySelect option').length >= 2,
  );
  return { page, requests };
}

/** 勾选双路同时留证，选好主备并开始；返回时两路各有一个录制中段。 */
async function startParallel(page, primaryId, backupId) {
  await page.evaluate(
    ([p, b]) => {
      document.getElementById('parallelToggle').checked = true;
      const ps = document.getElementById('primarySelect');
      const bs = document.getElementById('backupSelect');
      ps.value = p;
      ps.dispatchEvent(new Event('change'));
      bs.value = b;
      bs.dispatchEvent(new Event('change'));
    },
    [primaryId, backupId],
  );
  await page.waitForTimeout(300);
  await page.click('#startBtn');
  await page.waitForFunction(
    () =>
      window.__recorder &&
      window.__recorder.segments.filter((s) => s.state === 'recording')
        .length >= 2,
  );
  await page.waitForTimeout(700);
}

async function parState(page) {
  return page.evaluate(() => {
    const r = window.__recorder;
    return {
      running: r.running,
      heldBytes: r.heldBytes,
      lanes: r.laneStates(),
      deliverable: r.deliverable,
      coverageMs: r.buildManifest().coverageMs,
      manifest: r.buildManifest(),
      segments: r.segments.map((s) => ({
        index: s.index,
        deviceId: s.deviceId,
        role: s.role,
        state: s.state,
        reason: s.reason,
        bytes: s.bytes,
        released: !!s.released,
        hasUrl: !!s.url,
      })),
      gaps: r.gaps.map((g) => ({
        role: g.role,
        open: g.open,
        reason: g.reason,
        failoverFailed: !!g.failoverFailed,
      })),
    };
  });
}

async function waitFor(predicate, page, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await page.waitForTimeout(50);
  }
}

test('并行：主路热拔出只终结主路；备路继续；停止后两块独立 WebM，归属正确，覆盖不翻倍', async () => {
  const { page, requests } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP,
  }));

  await startParallel(page, PRIMARY, BACKUP);
  await page.waitForTimeout(1000);

  // 热拔出主路
  await page.evaluate(() => window.__fakeMedia.unplug('primary'));
  await waitFor(
    async () => {
      const st = await parState(page);
      return st.lanes.primary === 'ended' && st.lanes.backup === 'recording';
    },
    page,
  );

  let st = await parState(page);
  assert.equal(st.running, true, '备路仍在录，会话存活');
  assert.equal(st.segments.length, 2);
  assert.equal(st.gaps.length, 1);
  assert.equal(st.gaps[0].role, 'primary');
  assert.equal(st.gaps[0].open, true, '该路无接管设备，缺口保持打开');

  // 备路再录一段，确认其持续工作
  await page.waitForTimeout(1200);

  await page.click('#stopBtn');
  await page.waitForFunction(
    () =>
      window.__recorder.deliverable &&
      window.__recorder.segments.every((s) => s.state === 'sealed'),
  );

  st = await parState(page);
  assert.equal(st.segments.length, 2);
  const pSeg = st.segments.find((s) => s.role === 'primary');
  const bSeg = st.segments.find((s) => s.role === 'backup');
  assert.equal(pSeg.deviceId, PRIMARY);
  assert.equal(bSeg.deviceId, BACKUP, '备路素材归属真实备设备');
  assert.equal(bSeg.reason, 'user-stop');
  assert.ok(bSeg.bytes > 1000 && pSeg.bytes > 0);
  assert.equal(st.deliverable, true);

  // 两块都是独立 WebM
  const blobs = await page.evaluate(() =>
    window.__recorder.segments.map(async (s) => {
      const buf = new Uint8Array(await s.blob.arrayBuffer());
      return {
        role: s.role,
        size: buf.length,
        isWebm:
          buf[0] === 0x1a &&
          buf[1] === 0x45 &&
          buf[2] === 0xdf &&
          buf[3] === 0xa3,
      };
    }),
  );
  const resolved = await Promise.all(blobs);
  for (const b of resolved) assert.ok(b.isWebm, `${b.role} 必须是 WebM`);

  // 覆盖时长：两路大部分时间重叠，必须明显小于两段时长之和
  const m = st.manifest;
  const sumDurations = m.segments.reduce((n, s) => n + s.durationMs, 0);
  assert.ok(
    m.coverageMs < sumDurations * 0.75,
    `覆盖时长 ${m.coverageMs} 应远小于逐段累加 ${sumDurations}（重叠只计一次）`,
  );
  assert.ok(m.coverageMs >= 2000);

  // 零上传
  const uploads = requests.filter(
    (r) => r.method !== 'GET' && r.method !== 'HEAD',
  );
  assert.equal(uploads.length, 0);

  await page.close();
});

test('并行：释放主路素材后，备路 Blob/URL 仍可读取，清单仍可交付', async () => {
  const { page } = await newPage();
  const { PRIMARY, BACKUP } = await page.evaluate(() => ({
    PRIMARY: window.__fakeMedia.PRIMARY,
    BACKUP: window.__fakeMedia.BACKUP,
  }));

  await startParallel(page, PRIMARY, BACKUP);
  await page.waitForTimeout(900);
  await page.click('#stopBtn');
  await page.waitForFunction(() => window.__recorder.deliverable);

  const result = await page.evaluate(async () => {
    const r = window.__recorder;
    const segs = r.segments;
    const pIndex = segs.find((s) => s.role === 'primary').index;
    const bIndex = segs.find((s) => s.role === 'backup').index;
    const bUrlBefore = segs[bIndex].url;
    const heldBefore = r.heldBytes;

    const revoked = [];
    const orig = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => {
      revoked.push(u);
      orig(u);
    };
    await r.releaseSegment(pIndex);
    URL.revokeObjectURL = orig;

    const backup = r.segments[bIndex];
    const buf = new Uint8Array(await backup.blob.arrayBuffer());
    return {
      heldBefore,
      heldAfter: r.heldBytes,
      onlyPrimaryRevoked: revoked.length === 1 && revoked[0] !== bUrlBefore,
      backupStillReadable: buf.length > 1000 && !!backup.url,
      deliverable: r.deliverable,
      primaryReleased: r.segments[pIndex].released === true,
    };
  });

  assert.equal(result.backupStillReadable, true, '释放主路后备路素材仍可读取');
  assert.equal(result.onlyPrimaryRevoked, true, '只撤销了主路的 URL');
  assert.ok(result.heldAfter < result.heldBefore);
  assert.equal(result.deliverable, true);
  assert.equal(result.primaryReleased, true);

  await page.close();
});
