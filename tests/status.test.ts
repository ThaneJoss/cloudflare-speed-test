import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, TARGET } from '../src/constants.ts';
import { DnsClient } from '../src/dns.ts';
import { loadProbes } from '../src/probes.ts';
import { getStatus } from '../src/worker.ts';

const probes = loadProbes([{ id: 'v4', name: 'IPv4 test fixture', ip: '104.16.0.1', url: 'https://v4.example.com/__cfst' }]);

test('empty manifest remains visible when DNS reading fails', async () => {
  let reads = 0;
  const state = await getStatus([], async () => { reads++; throw new AppError(502, 'DNS unavailable', 'dns_transport_error'); });
  assert.equal(state.target, TARGET);
  assert.equal(state.candidates, 0);
  assert.equal(state.configured, false);
  assert.match(state.message, /probes\.json/);
  assert.equal(state.records, null);
  assert.deepEqual(state.dnsError, { error: 'DNS unavailable', code: 'dns_transport_error' });
  assert.equal(reads, 1);
});

test('configured candidates remain available when DNS reading fails', async () => {
  const state = await getStatus(probes, async () => { throw new AppError(502, 'DNS unavailable'); });
  assert.equal(state.configured, true);
  assert.equal(state.candidates, 1);
  assert.equal(state.message, '');
  assert.equal(state.records, null);
  assert.deepEqual(state.dnsError, { error: 'DNS unavailable' });
});

test('invalid DNS configuration is a partial status failure without fetching', async () => {
  let fetches = 0;
  const fetcher = (async () => { fetches++; return Response.json({ success: true, result: [] }); }) as typeof fetch;
  const state = await getStatus(probes, () => new DnsClient('invalid', '', fetcher).current());
  assert.equal(state.configured, true);
  assert.equal(state.records, null);
  assert.match(state.dnsError?.error || '', /CF_ZONE_ID/);
  assert.equal(fetches, 0);
});

test('a successful empty DNS response remains distinct from an unknown DNS state', async () => {
  const state = await getStatus(probes, async () => []);
  assert.deepEqual(state.records, []);
  assert.equal(state.dnsError, undefined);
});

test('unexpected errors still propagate instead of presenting partial success', async () => {
  const failure = new TypeError('unexpected implementation error');
  await assert.rejects(() => getStatus(probes, async () => { throw failure; }), error => error === failure);
});
