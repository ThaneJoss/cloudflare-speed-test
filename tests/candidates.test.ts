import test from 'node:test';
import assert from 'node:assert/strict';
import ipaddr from 'ipaddr.js';
import snapshot from '../data/cloudflare-cidrs.json' with { type: 'json' };
import { getCandidatePoolInfo, sampleCandidateIps, type RandomBytes } from '../src/candidates.ts';
import { getCandidates } from '../src/worker.ts';

function bytesFor(value: bigint, length: number): Uint8Array {
  return Uint8Array.from(Array.from({ length }, (_, index) => Number((value >> BigInt((length - index - 1) * 8)) & 0xffn)));
}

function scriptedRandom(values: bigint[]) {
  let calls = 0;
  const randomBytes: RandomBytes = length => {
    assert.ok(calls < values.length, 'unexpected additional random draw');
    return bytesFor(values[calls++], length);
  };
  return { randomBytes, get calls() { return calls; } };
}

const draws = (count = 10, start = 0) => Array.from({ length: count }, (_, index) => [0n, BigInt(index + start)]).flat();
const ipv4Draws = () => draws();
const ipv6Draws = () => draws();

test('the checked-in source contains fifteen IPv4 and seven IPv6 CIDRs with official provenance', () => {
  assert.equal(snapshot.checkedAt, '2026-10-12');
  assert.equal(snapshot.sources.ipv4, 'https://www.cloudflare.com/ips-v4/');
  assert.equal(snapshot.sources.ipv6, 'https://www.cloudflare.com/ips-v6/');
  assert.equal(snapshot.ipv4.length, 15);
  assert.equal(snapshot.ipv6.length, 7);
  assert.ok(snapshot.ipv4.every(cidr => ipaddr.parseCIDR(cidr)[0].kind() === 'ipv4'));
  assert.ok(snapshot.ipv6.every(cidr => ipaddr.parseCIDR(cidr)[0].kind() === 'ipv6'));
  const info = getCandidatePoolInfo();
  assert.deepEqual(info.cidrCounts, { ipv4: 15, ipv6: 7 });
  assert.deepEqual(info.distribution, { ipv4: 10, ipv6: 10 });
  assert.equal(info.sampleSize, 20);
  assert.equal(info.strategy, 'uniform-cidr-then-address');
});

test('raw candidates contain ten canonical unique addresses per family and twenty in total', () => {
  const random = scriptedRandom([...ipv4Draws(), ...ipv6Draws()]);
  const selected = sampleCandidateIps(random.randomBytes);
  assert.equal(selected.length, 20);
  for (const family of [4, 6]) {
    const addresses = selected.filter(candidate => candidate.family === family);
    assert.equal(addresses.length, 10);
    assert.equal(new Set(addresses.map(candidate => candidate.ip)).size, 10);
  }
  assert.equal(new Set(selected.map(candidate => candidate.ip)).size, 20);
  for (const candidate of selected) {
    const address = ipaddr.parse(candidate.ip);
    const [network, prefix] = ipaddr.parseCIDR(candidate.cidr);
    assert.equal(candidate.ip, address.toString());
    assert.equal(address.kind(), candidate.family === 4 ? 'ipv4' : 'ipv6');
    assert.ok(address.match(network, prefix));
    assert.equal(candidate.reachability, 'unknown');
    assert.deepEqual(Object.keys(candidate).sort(), ['cidr', 'family', 'ip', 'reachability']);
  }
});

test('IPv4 sampling reaches the first and last usable addresses while excluding network and broadcast', () => {
  const random = scriptedRandom([0n, 0n, 0n, 4093n, ...draws(8, 2), ...ipv6Draws()]);
  const selected = sampleCandidateIps(random.randomBytes);
  assert.equal(selected[0].ip, '173.245.48.1');
  assert.equal(selected[1].ip, '173.245.63.254');
  for (const candidate of selected.filter(candidate => candidate.family === 4)) {
    assert.notEqual(candidate.ip, ipaddr.IPv4.networkAddressFromCIDR(candidate.cidr).toString());
    assert.notEqual(candidate.ip, ipaddr.IPv4.broadcastAddressFromCIDR(candidate.cidr).toString());
  }
});

test('IPv4 unusable tail offsets and CIDR index tails are redrawn without modulo bias', () => {
  const random = scriptedRandom([15n, 0n, 4094n, 4095n, 0n, ...draws(9, 1), ...ipv6Draws()]);
  const selected = sampleCandidateIps(random.randomBytes);
  assert.equal(selected[0].ip, '173.245.48.1');
  assert.equal(selected.length, 20);
  assert.equal(random.calls, 43);
});

test('CIDR selection can reach the last IPv4 and IPv6 ranges and rejects an out-of-range IPv6 index', () => {
  const random = scriptedRandom([14n, 0n, ...draws(9, 1), 7n, 6n, 0n, ...draws(9, 1)]);
  const selected = sampleCandidateIps(random.randomBytes);
  assert.equal(selected[0].cidr, snapshot.ipv4[14]);
  assert.equal(selected[0].ip, '131.0.72.1');
  assert.equal(selected[10].cidr, snapshot.ipv6[6]);
  assert.equal(selected[10].ip, '2c0f:f248::');
  assert.equal(random.calls, 41);
});

test('IPv6 offsets preserve bits above Number precision and reach the end of a slash twenty-nine range', () => {
  const random = scriptedRandom([...ipv4Draws(), 5n, (1n << 103n) + (1n << 98n) + 1n, 5n, (1n << 99n) - 1n, ...draws(8)]);
  const selected = sampleCandidateIps(random.randomBytes);
  assert.equal(selected[10].ip, '2a06:98c4::1');
  assert.equal(selected[11].ip, '2a06:98c7:ffff:ffff:ffff:ffff:ffff:ffff');
  assert.equal(selected[10].cidr, '2a06:98c0::/29');
  assert.equal(selected[11].cidr, '2a06:98c0::/29');
});

test('duplicate draws refill only their own family until both quotas contain ten unique IPs', () => {
  const duplicates = [0n, 0n, 0n, 0n, 1n, ...draws(8, 2)];
  const random = scriptedRandom([...duplicates, ...duplicates]);
  const selected = sampleCandidateIps(random.randomBytes);
  assert.equal(selected.length, 20);
  for (const family of [4, 6]) {
    const addresses = selected.filter(candidate => candidate.family === family);
    assert.equal(addresses.length, 10);
    assert.equal(new Set(addresses.map(candidate => candidate.ip)).size, 10);
    assert.ok(addresses.every(candidate => candidate.cidr === snapshot[family === 4 ? 'ipv4' : 'ipv6'][0]));
  }
  assert.equal(random.calls, 42);
});

test('each call consumes fresh random bytes instead of reusing the previous raw round', () => {
  let calls = 0;
  const randomBytes: RandomBytes = length => bytesFor(BigInt(calls++), length);
  const first = sampleCandidateIps(randomBytes);
  const second = sampleCandidateIps(randomBytes);
  assert.equal(calls, 80);
  assert.notDeepEqual(first, second);
});

test('the candidate response contains source metadata and raw addresses without probe or write credentials', () => {
  const result = getCandidates();
  assert.equal(result.candidatePool.sampleSize, 20);
  assert.equal(result.candidates.length, 20);
  assert.deepEqual(Object.keys(result).sort(), ['candidatePool', 'candidates']);
  assert.ok(result.candidates.every(candidate => !('url' in candidate) && !('runToken' in candidate) && !('mbps' in candidate)));
});
