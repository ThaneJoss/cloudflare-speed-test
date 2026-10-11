import test from 'node:test';
import assert from 'node:assert/strict';
import { sample, measureProbe, pickBest } from '../public/measure.mjs';
import probeHandler from '../examples/probe-handler.mjs';

const probe = { id: 'v4', name: 'IPv4', ip: '104.16.0.1', family: 4, url: 'https://v4.example.com/__cfst' };
const plan = { rounds: 3, bytes: 262144, timeoutMs: 6000 };
const fixture = (url) => probeHandler.fetch(new Request(url), { PROBE_ID: 'v4' });

test('browser probe validates identity, nonce and exact body size', async () => {
  assert.ok((await sample(probe, 1024, 1000, fixture)).mbps > 0);
  await assert.rejects(() => sample(probe, 1024, 1000, async () => new Response('blocked', { status: 403 })), /HTTP 200/);
  await assert.rejects(() => sample(probe, 1024, 1000, async () => new Response('wrong', { headers: { 'X-CFST-ID': 'v4', 'X-CFST-Nonce': 'stale' } })), /标识/);
  await assert.rejects(() => sample(probe, 1024, 1000, async (url) => new Response(new Uint8Array(2), { headers: { 'X-CFST-ID': 'v4', 'X-CFST-Nonce': new URL(url).searchParams.get('nonce') } })), /不完整/);
});
test('compression and alternate route are excluded', async () => {
  for (const extra of [{ 'Content-Encoding': 'gzip' }, { 'Alt-Svc': 'h3=":443"' }]) {
    await assert.rejects(() => sample(probe, 1024, 1000, async url => {
      const response = fixture(url); const headers = new Headers(response.headers);
      for (const [k,v] of Object.entries(extra)) headers.set(k, v);
      return new Response(response.body, { headers });
    }));
  }
});
test('TLS or network failure does not become a fast candidate', async () => {
  const result = await measureProbe(probe, plan, () => {}, async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(result.successes, 0); assert.equal(result.latencyMs, null); assert.equal(pickBest([result], 4), null);
});
test('failed download and a single failed latency request prevent selection', async () => {
  let i = 0;
  const failedDownload = await measureProbe(probe, plan, () => {}, async () => { if (++i === 4) throw new Error('timeout'); return { latencyMs: 40, mbps: 20 }; });
  assert.equal(pickBest([failedDownload], 4), null);
  i = 0;
  const failedLatency = await measureProbe(probe, plan, () => {}, async () => { if (++i === 2) throw new Error('timeout'); return { latencyMs: 40, mbps: 20 }; });
  assert.equal(i, 3); assert.equal(pickBest([failedLatency], 4), null);
});
test('ranking favors low latency, then throughput for close candidates; families remain separate', () => {
  const base = { ...probe, successes: 3, attempts: 3, error: null };
  const results = [{ ...base, id: 'fast', latencyMs: 50, mbps: 10 }, { ...base, id: 'balanced', latencyMs: 54, mbps: 30 }, { ...base, id: 'slow', latencyMs: 120, mbps: 1000 }, { ...base, id: 'ipv6', family: 6, latencyMs: 5, mbps: 10 }];
  assert.equal(pickBest(results, 4).id, 'balanced'); assert.equal(pickBest(results, 6).id, 'ipv6'); assert.equal(pickBest([], 6), null);
});
