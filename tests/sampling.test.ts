import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRun } from '../src/auth.ts';
import { AppError, SAMPLE_SIZE } from '../src/constants.ts';
import { loadProbes } from '../src/probes.ts';
import { sampleProbes, uniqueProbes } from '../src/sampling.ts';
import { getPlan } from '../src/worker.ts';

const secret = 'test-only-signing-secret-with-32-characters';
const subject = 'sampling-test-user';
const manifest = 'sampling-test-manifest';
const makePool = (count: number) => loadProbes(Array.from({ length: count }, (_, index) => ({
  id: `edge-${index}`, name: `Test fixture ${index}`, ip: `104.16.${Math.floor(index / 256)}.${index % 256}`, url: `https://edge-${index}.example.com/__cfst`
})));

test('different hostnames with equivalent IPv6 or repeated IPv4 count as one IP each', () => {
  const pool = loadProbes([
    { id: 'first-v6', name: 'First IPv6 fixture', ip: '2606:4700:0:0:0:0:0:1', url: 'https://first-v6.example.com/__cfst' },
    { id: 'second-v6', name: 'Second IPv6 fixture', ip: '2606:4700::1', url: 'https://second-v6.example.com/__cfst' },
    { id: 'first-v4', name: 'First IPv4 fixture', ip: '104.16.0.1', url: 'https://first-v4.example.com/__cfst' },
    { id: 'second-v4', name: 'Second IPv4 fixture', ip: '104.16.0.1', url: 'https://second-v4.example.com/__cfst' }
  ]);
  const unique = uniqueProbes(pool);
  assert.deepEqual(unique.map(probe => probe.id), ['first-v6', 'first-v4']);
  assert.equal(unique[0], pool[0]);
  assert.equal(unique[1], pool[2]);
  assert.equal(pool.length, 4);
});

test('sampling draws ten unique IPs without changing the source pool or probe identities', () => {
  const pool = makePool(20);
  const before = structuredClone(pool);
  const selected = sampleProbes(pool, () => 0);
  assert.equal(selected.length, SAMPLE_SIZE);
  assert.equal(new Set(selected.map(probe => probe.ip)).size, SAMPLE_SIZE);
  assert.ok(selected.every(probe => pool.includes(probe)));
  assert.deepEqual(pool, before);
});

test('the full source pool can exceed twelve and mixed families follow the drawn pool', () => {
  const pool = loadProbes(Array.from({ length: 20 }, (_, index) => ({
    id: `mixed-${index}`, name: `Mixed fixture ${index}`, ip: index % 2 ? `2606:4700::${(index + 1).toString(16)}` : `104.16.0.${index + 1}`, url: `https://mixed-${index}.example.com/__cfst`
  })));
  const selected = sampleProbes(pool, () => 0);
  assert.equal(pool.length, 20);
  assert.equal(selected.filter(probe => probe.family === 4).length, 5);
  assert.equal(selected.filter(probe => probe.family === 6).length, 5);
});

test('an IPv4-only pool supplies ten IPv4 candidates without reserving another family', () => {
  const selected = sampleProbes(makePool(20), () => 0);
  assert.equal(selected.length, SAMPLE_SIZE);
  assert.ok(selected.every(probe => probe.family === 4));
});

test('a pool with fewer than ten distinct IPs reports its real count before using randomness', () => {
  const pool = makePool(9);
  pool.push({ ...pool[0], id: 'duplicate', url: 'https://duplicate.example.com/__cfst' });
  let draws = 0;
  assert.throws(() => sampleProbes(pool, () => { draws++; return 0; }), error => error instanceof AppError && error.status === 503 && error.code === 'PROBE_POOL_TOO_SMALL' && /只有 9/.test(error.message) && /10/.test(error.message));
  assert.equal(draws, 0);
});

test('each draw consumes fresh randomness; exactly ten IPs may repeat with a different order', () => {
  const pool = makePool(10);
  let calls = 0;
  const random = () => calls++ < SAMPLE_SIZE ? 0 : 1;
  const first = sampleProbes(pool, random);
  const second = sampleProbes(pool, random);
  assert.equal(calls, SAMPLE_SIZE * 2);
  assert.deepEqual(new Set(first.map(probe => probe.id)), new Set(second.map(probe => probe.id)));
  assert.notDeepEqual(first.map(probe => probe.id), second.map(probe => probe.id));
});

test('uint32 remainder values are redrawn rather than giving low indices extra probability', () => {
  let calls = 0;
  const selected = sampleProbes(makePool(10), () => calls++ === 0 ? 0xffffffff : 0);
  assert.equal(calls, SAMPLE_SIZE + 1);
  assert.equal(selected.length, SAMPLE_SIZE);
});

test('an undersized plan reports the pool count before requesting ranges or validating DNS', async () => {
  let rangeCalls = 0;
  let validations = 0;
  await assert.rejects(() => getPlan(makePool(8), secret, subject, manifest, {
    getRanges: async () => { rangeCalls++; return []; },
    validateDns: async () => { validations++; }
  }), error => error instanceof AppError && error.status === 503 && /只有 8/.test(error.message) && /10/.test(error.message));
  assert.equal(rangeCalls, 0);
  assert.equal(validations, 0);
});

test('the real plan validates only the ten sampled entries in batches of at most three and signs their IDs', async () => {
  const pool = makePool(1000);
  const checked: string[] = [];
  let rangeCalls = 0;
  let active = 0;
  let maxActive = 0;
  const response = await getPlan(pool, secret, subject, manifest, {
    randomUint32: () => 0,
    getRanges: async () => { rangeCalls++; return ['104.16.0.0/13']; },
    validateDns: async probe => {
      active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      checked.push(probe.id); active--;
    }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = body.probes.map((probe: { id: string }) => probe.id);
  assert.equal(body.sampleSize, SAMPLE_SIZE);
  assert.equal(ids.length, SAMPLE_SIZE);
  assert.deepEqual(checked, ids);
  assert.equal(rangeCalls, 1);
  assert.equal(maxActive, 3);
  assert.deepEqual(await verifyRun(secret, body.runToken, subject, manifest), ids);
  assert.ok(!ids.includes(pool[SAMPLE_SIZE].id));
});

test('a failed sampled DNS check returns all ten selected entries and never replaces or signs the subset', async () => {
  const pool = makePool(20);
  const checked: string[] = [];
  const response = await getPlan(pool, '', subject, manifest, {
    randomUint32: () => 0,
    getRanges: async () => ['104.16.0.0/13'],
    validateDns: async probe => {
      checked.push(probe.id);
      if (probe.id === 'edge-3') throw new AppError(502, 'DNS response unavailable');
      if (probe.id === 'edge-8') throw new Error('DNS timeout');
    }
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, 'PROBE_SAMPLE_REJECTED');
  assert.equal(body.selected.length, SAMPLE_SIZE);
  assert.deepEqual(checked, body.selected.map((probe: { id: string }) => probe.id));
  assert.deepEqual(body.rejected, [{ id: 'edge-3', error: 'DNS response unavailable' }, { id: 'edge-8', error: 'DNS timeout' }]);
  assert.equal('runToken' in body, false);
  assert.equal('probes' in body, false);
});

test('each plan request independently redraws and revalidates instead of reusing the previous round', async () => {
  const pool = makePool(20);
  let draws = 0;
  const checked: string[] = [];
  const dependencies = {
    randomUint32: () => draws++ < SAMPLE_SIZE ? 0 : 1,
    getRanges: async () => ['104.16.0.0/13'],
    validateDns: async (probe: { id: string }) => { checked.push(probe.id); }
  };
  const first = await (await getPlan(pool, secret, subject, manifest, dependencies)).json();
  const second = await (await getPlan(pool, secret, subject, manifest, dependencies)).json();
  assert.equal(draws, SAMPLE_SIZE * 2);
  assert.equal(checked.length, SAMPLE_SIZE * 2);
  assert.notDeepEqual(first.probes, second.probes);
  assert.deepEqual(await verifyRun(secret, second.runToken, subject, manifest), second.probes.map((probe: { id: string }) => probe.id));
});
