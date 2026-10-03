/**
 * tools/make-y4m.mjs — 生成 Chromium 假摄像头用的 Y4M 测试视频。
 * 两台假设备喂不同画面（纯色 / 移动竖条），便于区分主备来源。
 *
 * 用法：node tools/make-y4m.mjs [outDir=tests/fixtures]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const W = 320;
const H = 240;
const FPS = 30;
const FRAMES = 120; // 4 秒
const outDir = process.argv[2] || 'tests/fixtures';

function header() {
  return Buffer.from(
    `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420\n`,
    'ascii'
  );
}

function frameTag() {
  return Buffer.from('FRAME\n', 'ascii');
}

/** 生成一帧 YUV420p（Y 全平面 + 各 1/4 尺寸的 U/V）。 */
function makeFrame(mode, n) {
  const y = Buffer.alloc(W * H);
  const u = Buffer.alloc((W / 2) * (H / 2));
  const v = Buffer.alloc((W / 2) * (H / 2));
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      let val;
      if (mode === 'solid') {
        // 青蓝色平面
        val = 100;
      } else {
        // 移动亮竖条在灰底上扫过
        const barX = (n * 8) % W;
        val = Math.abs(col - barX) < 20 ? 235 : 60;
      }
      y[row * W + col] = val;
    }
  }
  if (mode === 'solid') {
    u.fill(110);
    v.fill(170);
  } else {
    u.fill(128);
    v.fill(128);
  }
  return Buffer.concat([frameTag(), y, u, v]);
}

function build(mode) {
  const parts = [header()];
  for (let i = 0; i < FRAMES; i++) parts.push(makeFrame(mode, i));
  return Buffer.concat(parts);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'fake-primary.y4m'), build('solid'));
writeFileSync(join(outDir, 'fake-backup.y4m'), build('bar'));
console.log(`wrote ${join(outDir, 'fake-primary.y4m')}`);
console.log(`wrote ${join(outDir, 'fake-backup.y4m')}`);
