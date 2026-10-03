/**
 * browser-fake-media.js — 注入到页面的“虚拟双摄像头”（通过 addInitScript）。
 *
 * 它在真实 Chromium 中用两个 canvas captureStream() 伪造主/备摄像头，
 * 其余（MediaRecorder、ObjectURL、权限、devicechange）全是浏览器原生能力。
 * 测试可在任意时刻：
 *   window.__fakeMedia.unplug(role)  —— 热拔出（轨道 stop + ended + devicechange）
 *   window.__fakeMedia.mute(role)    —— 轨道静音（mute 事件）
 *   window.__fakeMedia.unmute(role)
 *   window.__fakeMedia.denyOnce(id)  —— 下一次 getUserMedia 拒绝
 */
export const FAKE_MEDIA_INIT = `
(() => {
  if (window.__fakeMediaInstalled) return;
  window.__fakeMediaInstalled = true;

  const PRIMARY = 'fake-device-primary';
  const BACKUP = 'fake-device-backup';
  const SPARE = 'fake-device-spare';
  const DEVICES = [
    { deviceId: PRIMARY, label: 'Virtual Primary Cam', kind: 'videoinput' },
    { deviceId: BACKUP,  label: 'Virtual Backup Cam',  kind: 'videoinput' },
    { deviceId: SPARE,   label: 'Virtual Spare Cam',   kind: 'videoinput' }
  ];

  function makeCanvas(role, color) {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const ctx = c.getContext('2d');
    let n = 0;
    function draw() {
      ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#ffffff';
      const x = (n * 6) % 320;
      ctx.fillRect(x, 90, 40, 60);
      ctx.font = '16px monospace';
      ctx.fillText(role + ' ' + (n++), 10, 20);
    }
    const timer = setInterval(draw, 33);
    draw();
    return { canvas: c, timer };
  }

  const sources = {
    [PRIMARY]: makeCanvas('PRIMARY', '#1b3fae'),
    [BACKUP]: makeCanvas('BACKUP', '#0b2b14'),
    [SPARE]: makeCanvas('SPARE', '#5a1b6e')
  };
  /** deviceId -> 当前活动的 MediaStreamTrack 列表 */
  const activeTracks = new Map();
  const unplugged = new Set();
  const denyOnce = new Set();

  const real = navigator.mediaDevices;
  const fake = Object.create(real);

  fake.enumerateDevices = async () => {
    const realOnes = await real.enumerateDevices.call(real);
    const virt = DEVICES
      .filter((d) => !unplugged.has(d.deviceId))
      .map((d) => ({ ...d, groupId: 'fake-group', toJSON() { return this; } }));
    return [...virt, ...realOnes.filter((d) => d.kind !== 'videoinput')];
  };

  // 事件目标语义（devicechange 等）必须转发给真实对象，避免 Illegal invocation。
  for (const m of [
    'addEventListener', 'removeEventListener', 'dispatchEvent'
  ]) {
    fake[m] = (...args) => real[m](...args);
  }
  if (real.permissions) {
    fake.permissions = real.permissions;
  }

  fake.getUserMedia = async (constraints) => {
    const want =
      constraints?.video?.deviceId?.exact ||
      constraints?.video?.deviceId ||
      null;
    await new Promise((r) => setTimeout(r, 30)); // 模拟真实异步
    if (want && denyOnce.has(want)) {
      denyOnce.delete(want);
      const e = new Error('denied by fake');
      e.name = 'NotAllowedError';
      throw e;
    }
    if (want && unplugged.has(want)) {
      const e = new Error('device unplugged');
      e.name = 'NotReadableError';
      throw e;
    }
    const id = want || PRIMARY;
    const src = sources[id];
    if (!src) return real.getUserMedia.call(real, constraints);
    const stream = src.canvas.captureStream(30);
    // 给轨道补上可观察的 mute/unmute 与手动 ended 的能力
    for (const tr of stream.getVideoTracks()) {
      tr._fakeId = id;
      if (!activeTracks.has(id)) activeTracks.set(id, []);
      activeTracks.get(id).push(tr);
      const origStop = tr.stop.bind(tr);
      tr.stop = () => {
        if (tr.readyState === 'ended') return;
        origStop();
        queueMicrotask(() => tr.dispatchEvent(new Event('ended')));
      };
    }
    return stream;
  };

  // defineGetter 替换 navigator.mediaDevices
  try {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true, value: fake
    });
  } catch { /* ignore */ }

  window.__fakeMedia = {
    PRIMARY, BACKUP, SPARE,
    unplug(idOrRole) {
      const id = idOrRole === 'primary' ? PRIMARY
        : idOrRole === 'backup' ? BACKUP : idOrRole;
      unplugged.add(id);
      // 真实浏览器：轨道先结束（ended），设备列表变化（devicechange）随后。
      for (const tr of activeTracks.get(id) || []) {
        if (tr.readyState !== 'ended') {
          tr.stop();
        }
      }
      activeTracks.delete(id);
      setTimeout(() => real.dispatchEvent(new Event('devicechange')), 0);
    },
    mute(idOrRole) {
      const id = idOrRole === 'primary' ? PRIMARY
        : idOrRole === 'backup' ? BACKUP : idOrRole;
      for (const tr of activeTracks.get(id) || []) {
        if (tr.readyState === 'live') {
          Object.defineProperty(tr, 'muted', { configurable: true, value: true });
          tr.dispatchEvent(new Event('mute'));
        }
      }
    },
    denyOnce(idOrRole) {
      const id = idOrRole === 'primary' ? PRIMARY
        : idOrRole === 'backup' ? BACKUP : idOrRole;
      denyOnce.add(id);
    }
  };
})();
`;
