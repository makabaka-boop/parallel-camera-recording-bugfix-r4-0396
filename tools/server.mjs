/**
 * tools/server.mjs — 最小静态服务器（仅本机使用）。
 * 用法：node tools/server.mjs [--port 8080] [--root src]
 *
 * 注意：本服务只托管页面本身；录制的媒体数据绝不会被发送到这里。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const rootArg = args.indexOf('--root');
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', rootArg >= 0 ? args[rootArg + 1] : 'src');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      // 媒体绝不缓存到磁盘式 HTTP 缓存之外；这里仅普通静态缓存策略。
      'Cache-Control': 'no-store'
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}`);
});
