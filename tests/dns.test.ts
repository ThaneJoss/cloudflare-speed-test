import test from 'node:test';
import assert from 'node:assert/strict';
import { DnsClient, planChanges, type DnsRecord } from '../src/dns.ts';
import { TARGET } from '../src/constants.ts';
import { type Probe } from '../src/probes.ts';

const v4: Probe = { id: 'edge4', name: 'IPv4', ip: '104.16.0.1', family: 4, url: 'https://v4.example.com/__cfst' };
const v6: Probe = { id: 'edge6', name: 'IPv6', ip: '2606:4700::1', family: 6, url: 'https://v6.example.com/__cfst' };
const record = (type: string, content: string): DnsRecord => ({ id: `record-${type}`, name: TARGET, type, content, ttl: 300, proxied: false });
const reply = (result: unknown) => Response.json({ success: true, result });

test('new target creates A and AAAA together with DNS only and exact target', () => {
  const changes = planChanges([], [v4, v6]);
  assert.equal(changes.posts.length, 2);
  assert.ok(changes.posts.every(r => r.name === TARGET && r.proxied === false && r.ttl === 300));
  assert.equal(changes.patches.length, 0);
});
test('missing IPv6 result preserves existing AAAA and unrelated records', () => {
  const changes = planChanges([record('AAAA', '2606:4700::2'), record('TXT', 'keep')], [v4]);
  assert.deepEqual(changes.posts.map(p => p.type), ['A']);
  assert.deepEqual(changes.patches, []);
  assert.equal('deletes' in changes, false);
});
test('CNAME, duplicate A and managed records abort before mutation', () => {
  assert.throws(() => planChanges([record('CNAME', 'example.net')], [v4]), /CNAME/);
  assert.throws(() => planChanges([record('A', '104.16.0.2'), record('A', '104.16.0.3')], [v4]), /多条/);
  assert.throws(() => planChanges([{ ...record('A', '104.16.0.2'), meta: { managed_by_apps: true } }], [v4]), /管理/);
  assert.throws(() => planChanges([], [v4, v4]), /地址族/);
});
test('canonical IPv6 and unchanged records produce no write; orange cloud gets disabled', () => {
  assert.deepEqual(planChanges([record('AAAA', '2606:4700:0:0:0:0:0:1')], [v6]), { patches: [], posts: [] });
  assert.equal(planChanges([{ ...record('A', v4.ip), proxied: true }], [v4]).patches[0].proxied, false);
});
test('writer batches both families and verifies readback without deleting', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return reply([record('A', '104.16.0.2')]);
    if (calls.length === 2) return reply({});
    return reply([record('A', v4.ip), record('AAAA', v6.ip)]);
  };
  const result = await new DnsClient('a'.repeat(32), 'fake-token-for-tests', fetcher as typeof fetch).write([v4, v6]);
  assert.equal(result.changed, true);
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /\/batch$/);
  const batch = JSON.parse(String(calls[1].init?.body));
  assert.equal(batch.patches.length, 1); assert.equal(batch.posts.length, 1); assert.equal(batch.deletes, undefined);
});
test('API rejection never reports success or attempts a second mutation', async () => {
  let calls = 0;
  const fetcher = async () => ++calls === 1 ? reply([]) : Response.json({ success: false, errors: [{ code: 1004, message: 'Invalid DNS record' }] }, { status: 400 });
  await assert.rejects(() => new DnsClient('a'.repeat(32), 'fake', fetcher as typeof fetch).write([v4, v6]), /1004/);
  assert.equal(calls, 2);
});
test('unexpected readback is reported, not falsely called a successful write', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return calls === 2 ? reply({}) : reply([record('A', '104.16.0.2')]); };
  await assert.rejects(() => new DnsClient('a'.repeat(32), 'fake', fetcher as typeof fetch).write([v4]), /预期不同/);
});

test('DNS fetch uses manual redirects and rejects them without retrying a write', async () => {
  const calls: RequestInit[] = [];
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init!);
    assert.equal(init?.redirect, 'manual');
    return calls.length === 1 ? reply([]) : new Response(null, { status: 307, headers: { Location: 'https://other.test/' } });
  };
  await assert.rejects(() => new DnsClient('a'.repeat(32), 'fake', fetcher as typeof fetch).write([v4]), { code: 'DNS_API_REDIRECT', status: 502 });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
});

test('timeout, connection, malformed response and API rejection have distinct safe diagnostics', async () => {
  const cases = [
    { code: 'DNS_API_TIMEOUT', fetcher: async () => { throw new DOMException('fixture', 'TimeoutError'); } },
    { code: 'DNS_API_CONNECTION_FAILED', fetcher: async () => { throw new TypeError('fixture fake-secret'); } },
    { code: 'DNS_API_INVALID_RESPONSE', fetcher: async () => new Response('<html>fixture fake-secret</html>') },
    { code: 'DNS_API_INVALID_RESPONSE', fetcher: async () => Response.json(null) },
    { code: 'DNS_API_REJECTED', fetcher: async () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403, headers: { 'CF-Ray': 'test-ray' } }) }
  ];
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    for (const item of cases) await assert.rejects(() => new DnsClient('a'.repeat(32), 'fake-secret', item.fetcher as typeof fetch).current(), { code: item.code, status: 502 });
  } finally { console.error = original; }
  assert.equal(logs.length, cases.length);
  assert.ok(logs.every(log => !log.includes('fake-secret') && !log.includes('Authorization')));
  assert.deepEqual(JSON.parse(logs.at(-1)!).upstreamCodes, [10000]);
  assert.equal(JSON.parse(logs.at(-1)!).upstreamRay, 'test-ray');
});

test('a token containing line breaks fails before issuing a DNS request without exposing its value', () => {
  assert.throws(() => new DnsClient('a'.repeat(32), 'fake-secret\n'), { code: 'DNS_CONFIG_INVALID', status: 503 });
});
