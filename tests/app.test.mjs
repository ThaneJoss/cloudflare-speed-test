import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/, '');
const probe = { id: 'v4', name: 'IPv4 test fixture', family: 4, ip: '104.16.0.1', url: 'https://v4.example.com/__cfst' };

// Run the real app handlers with a small DOM and explicit measurement fixtures.
async function startApp(state, responseStatus = 200) {
  const nodes = new Map();
  const node = () => ({ textContent: '', className: '', disabled: false, hidden: false, value: 0, listeners: new Map(), replaceChildren() { this.textContent = ''; }, append() {}, addEventListener(event, handler) { this.listeners.set(event, handler); } });
  const element = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const calls = [];
  const context = vm.createContext({
    document: { hidden: false, getElementById: element, createElement: node, addEventListener() {} },
    window: { addEventListener() {} },
    Date, Response, AbortSignal,
    crypto: { getRandomValues(bytes) { bytes.fill(0); return bytes; } },
    setTimeout() { return 1; }, clearTimeout() {},
    async fetch(path) {
      calls.push(path);
      if (path === '/api/status') return Response.json(state, { status: responseStatus });
      if (path === '/api/plan') return Response.json({ probes: [probe], rejected: [], rounds: 3, expiresAt: Date.now() + 600000, runToken: 'test-fixture' });
      throw new Error(`Unexpected request: ${path}`);
    },
    async measureProbe() { return { ...probe, latencyMs: 10, mbps: 20, successes: 3, attempts: 3 }; },
    pickBest(results, family) { return results.find(result => result.family === family); }
  });
  await vm.runInContext(`(async () => {\n${source}\n})()`, context);
  return { element, calls, click: id => element(id).listeners.get('click')() };
}

test('empty probes and failed DNS both remain visible, with measurement and writing disabled', async () => {
  const app = await startApp({ configured: false, candidates: 0, message: '请配置 probes.json。', records: null, dnsError: { error: 'DNS unavailable' } });
  assert.match(app.element('status').textContent, /probes\.json/);
  assert.match(app.element('status').textContent, /DNS unavailable/);
  assert.equal(app.element('current').textContent, '暂时无法读取。');
  assert.equal(app.element('test').disabled, true);
  assert.equal(app.element('write').disabled, true);
  assert.deepEqual(app.calls, ['/api/status']);
});

test('configured probes can measure after DNS failure, but completed results cannot write', async () => {
  const app = await startApp({ configured: true, candidates: 1, message: '', records: null, dnsError: { error: 'DNS unavailable' } });
  assert.equal(app.element('test').disabled, false);
  assert.equal(app.element('write').disabled, true);
  await app.click('test');
  assert.match(app.element('phase').textContent, /测速完成/);
  assert.match(app.element('status').textContent, /写入不可用/);
  assert.equal(app.element('write').disabled, true);
  await app.click('write');
  assert.deepEqual(app.calls, ['/api/status', '/api/plan']);
});

test('known empty DNS records allow writing only after completed measurement', async () => {
  const app = await startApp({ configured: true, candidates: 1, message: '', records: [] });
  assert.match(app.element('current').textContent, /尚无记录/);
  assert.equal(app.element('write').disabled, true);
  await app.click('test');
  assert.equal(app.element('write').disabled, false);
});

test('authentication failure identifies login while server failure identifies unavailable status', async () => {
  const login = await startApp({ error: '请登录' }, 401);
  assert.equal(login.element('phase').textContent, '请登录');
  assert.equal(login.element('test').disabled, true);
  const server = await startApp({ error: '服务失败' }, 500);
  assert.equal(server.element('phase').textContent, '无法读取状态');
  assert.equal(server.element('test').disabled, true);
});
