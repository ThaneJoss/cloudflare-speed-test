import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, TARGET } from '../src/constants.ts';
import { DnsClient } from '../src/dns.ts';
import { loadProbes } from '../src/probes.ts';
import { getStatus } from '../src/worker.ts';

const probes = loadProbes(Array.from({ length: 10 }, (_, index) => ({ id: `v4-${index}`, name: `IPv4 test fixture ${index}`, ip: `104.16.0.${index + 1}`, url: `https://v4-${index}.example.com/__cfst` })));

test('empty manifest remains visible when DNS reading fails', async () => {
  let reads = 0;
  const state = await getStatus([], async () => { reads++; throw new AppError(502, 'DNS unavailable', 'dns_transport_error'); });
  assert.equal(state.target, TARGET);
  assert.equal(state.probePool.count, 0);
  assert.equal(state.probePool.sampleSize, 10);
  assert.equal(state.probePool.configured, false);
  assert.match(state.probePool.message, /probes\.json/);
  assert.deepEqual(state.candidatePool.cidrCounts, { ipv4: 15, ipv6: 7 });
  assert.deepEqual(state.candidatePool.distribution, { ipv4: 10, ipv6: 10 });
  assert.equal(state.candidatePool.sampleSize, 20);
  assert.equal('configured' in state, false);
  assert.equal('candidates' in state, false);
  assert.equal(state.records, null);
  assert.deepEqual(state.dnsError, { error: 'DNS unavailable', code: 'dns_transport_error' });
  assert.equal(reads, 1);
});

test('configured candidates remain available when DNS reading fails', async () => {
  const state = await getStatus(probes, async () => { throw new AppError(502, 'DNS unavailable'); });
  assert.equal(state.probePool.configured, true);
  assert.equal(state.probePool.count, 10);
  assert.equal(state.probePool.message, '');
  assert.equal(state.records, null);
  assert.deepEqual(state.dnsError, { error: 'DNS unavailable' });
});

test('status counts unique IPs and explains an undersized pool even if ten entries were supplied', async () => {
  const duplicated = [...probes.slice(0, 9), { ...probes[0], id: 'duplicate', url: 'https://duplicate.example.com/__cfst' }];
  const state = await getStatus(duplicated, async () => []);
  assert.equal(state.probePool.count, 9);
  assert.equal(state.probePool.sampleSize, 10);
  assert.equal(state.probePool.configured, false);
  assert.match(state.probePool.message, /只有 9/);
  assert.match(state.probePool.message, /10/);
});

test('invalid DNS configuration is a partial status failure without fetching', async () => {
  let fetches = 0;
  const fetcher = (async () => { fetches++; return Response.json({ success: true, result: [] }); }) as typeof fetch;
  const state = await getStatus(probes, () => new DnsClient('invalid', '', fetcher).current());
  assert.equal(state.probePool.configured, true);
  assert.equal(state.records, null);
  assert.match(state.dnsError?.error || '', /CF_ZONE_ID/);
  assert.equal(fetches, 0);
});

test('a successful empty DNS response remains distinct from an unknown DNS state', async () => {
  const state = await getStatus(probes, async () => []);
  assert.deepEqual(state.records, []);
  assert.equal('dnsError' in state, false);
});

test('unexpected errors still propagate instead of presenting partial success', async () => {
  const failure = new TypeError('unexpected implementation error');
  await assert.rejects(() => getStatus(probes, async () => { throw failure; }), error => error === failure);
});
