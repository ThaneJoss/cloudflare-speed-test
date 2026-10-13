import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Serve only checked-in UI assets on loopback. APIs are intercepted by Playwright;
// this server never loads Worker secrets, authenticates, or contacts upstreams.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/measure.mjs', ['measure.mjs', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);

const server = createServer(async (request, response) => {
  const asset = assets.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (request.method !== 'GET' || !asset) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }).end(body);
  } catch {
    response.writeHead(500).end('Could not read test asset');
  }
});

server.listen(4173, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close());
}
