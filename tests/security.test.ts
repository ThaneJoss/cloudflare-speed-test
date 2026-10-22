import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker, { authorizeSelection, getCandidates, getPlan, parseSelection, requireOrigin } from '../src/worker.ts';
import { authenticate, signRun, verifyRun } from '../src/auth.ts';
import { loadProbes, validateProbeDns, type Probe } from '../src/probes.ts';
import { sampleCandidateIps } from '../src/candidates.ts';

const probes = loadProbes([{ id: 'v4', name: 'IPv4', ip: '104.16.0.1', url: 'https://v4.example.com/__cfst' }]);
const secret = 'test-only-signing-secret-with-32-characters';
const origin = 'https://cf-speed-test.thanejoss.com';

test('write origin requires exact app origin and JSON', () => {
  assert.throws(() => requireOrigin(new Request(`${origin}/api/write`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' } }), origin), /仅允许/);
  assert.throws(() => requireOrigin(new Request(`${origin}/api/write`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' } }), origin), /application\/json/);
});
test('unknown candidates, duplicate families and fake success are rejected', () => {
  const base = { id: 'v4', successes: 3, attempts: 3, latencyMs: 50, mbps: 20 };
  for (const selected of [[{ ...base, id: 'arbitrary-ip' }], [base, base], [{ ...base, successes: 2 }], [{ ...base, latencyMs: NaN }]]) assert.throws(() => parseSelection({ runToken: 'fake', selected }, probes, ['v4']));
  assert.equal(parseSelection({ runToken: 'fake', selected: [{ ...base, ip: '127.0.0.1' }], target: 'attacker.example' }, probes, ['v4']).selected[0].ip, '104.16.0.1');
});
test('run token binds user, manifest, expiration and signature', async () => {
  const token = await signRun(secret, 'user1', ['v4'], 'manifest1');
  assert.deepEqual(await verifyRun(secret, token, 'user1', 'manifest1'), ['v4']);
  await assert.rejects(() => verifyRun(secret, token, 'user2', 'manifest1'));
  await assert.rejects(() => verifyRun(secret, token, 'user1', 'manifest2'));
  await assert.rejects(() => verifyRun(secret + 'wrong', token, 'user1', 'manifest1'));
  const expired = await new SignJWT({ ids: ['v4'], manifest: 'manifest1' }).setProtectedHeader({ alg: 'HS256' }).setIssuer('cf-speed-test').setAudience('dns-write').setSubject('user1').setIssuedAt(1).setExpirationTime(2).setJti('old').sign(new TextEncoder().encode(secret));
  await assert.rejects(() => verifyRun(secret, expired, 'user1', 'manifest1'));
});
test('write authorization accepts sampled candidates and rejects a real pool candidate absent from the signed round', async () => {
  const pool = loadProbes(Array.from({ length: 20 }, (_, index) => ({ id: `edge-${index}`, name: `Test fixture ${index}`, ip: `104.16.0.${index + 1}`, url: `https://edge-${index}.example.com/__cfst` })));
  const manifest = 'sampling-security-test-manifest';
  const response = await getPlan(pool, secret, 'user1', manifest, { randomUint32: () => 0, getRanges: async () => ['104.16.0.0/13'], validateDns: async () => {} });
  const plan = await response.json<{ probes: Probe[]; runToken: string }>();
  const result = { id: plan.probes[0].id, successes: 3, attempts: 3, latencyMs: 50, mbps: 20 };
  const selected = await authorizeSelection({ runToken: plan.runToken, selected: [result] }, pool, secret, 'user1', manifest);
  assert.equal(selected[0].id, plan.probes[0].id);
  const outside = pool.find(probe => !plan.probes.some((sampled: { id: string }) => sampled.id === probe.id))!;
  await assert.rejects(() => authorizeSelection({ runToken: plan.runToken, selected: [{ ...result, id: outside.id }] }, pool, secret, 'user1', manifest), /候选未通过本次入口检查/);
});
test('missing Access configuration or JWT fails closed', async () => {
  await assert.rejects(() => authenticate(new Request(origin), '', ''), /配置/);
  await assert.rejects(() => authenticate(new Request(origin), 'example.cloudflareaccess.com', 'aud'), /登录/);
  // Missing bindings and invalid values are intentional authentication fixtures.
  const response = await worker.fetch(new Request(`${origin}/api/write`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' } }), { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', APP_ORIGIN: origin } as unknown as Env);
  assert.equal(response.status, 503);
});
test('raw candidate generation retains exact Origin and Access requirements', async () => {
  const wrongOrigin = await worker.fetch(new Request(`${origin}/api/candidates`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' } }), { APP_ORIGIN: origin } as Env);
  assert.equal(wrongOrigin.status, 403);
  const missingLogin = await worker.fetch(new Request(`${origin}/api/candidates`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' } }), { APP_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'test-audience' } as unknown as Env);
  assert.equal(missingLogin.status, 401);
});
test('an authenticated raw request works with the empty probe manifest and no DNS, limiter or signing bindings', async t => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'raw-candidate-test-key', alg: 'RS256', use: 'sig' };
  const issuer = 'https://example.cloudflareaccess.com';
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setAudience('test-audience').setSubject('raw-candidate-test-user').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
  const response = await worker.fetch(new Request(`${origin}/api/candidates`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token } }), { APP_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'test-audience' } as unknown as Env);
  assert.equal(response.status, 200);
  const body = await response.json<ReturnType<typeof getCandidates>>();
  assert.equal(body.candidates.length, 20);
  assert.equal(body.candidatePool.sampleSize, 20);
  assert.deepEqual(body.candidatePool.distribution, { ipv4: 10, ipv6: 10 });
  assert.equal(body.candidates.filter((candidate: { family: number }) => candidate.family === 4).length, 10);
  assert.equal(body.candidates.filter((candidate: { family: number }) => candidate.family === 6).length, 10);
  assert.ok(body.candidates.every((candidate: { reachability: string }) => candidate.reachability === 'unknown'));
  assert.equal('runToken' in body, false);
  assert.deepEqual(calls, [`${issuer}/cdn-cgi/access/certs`]);
});
test('raw addresses cannot become writable probes through a signed probe run', async () => {
  let draws = 0;
  const raw = sampleCandidateIps(length => {
    const bytes = new Uint8Array(length);
    bytes[length - 1] = draws++;
    return bytes;
  })[0];
  const token = await signRun(secret, 'user1', ['v4'], 'raw-write-test-manifest');
  const result = { successes: 3, attempts: 3, latencyMs: 50, mbps: 20 };
  await assert.rejects(() => authorizeSelection({ runToken: token, selected: [{ ...raw, ...result, id: raw.ip }] }, probes, secret, 'user1', 'raw-write-test-manifest'), /候选不在本次测速清单内/);
  const registered = await authorizeSelection({ runToken: token, selected: [{ ...raw, ...result, id: 'v4' }] }, probes, secret, 'user1', 'raw-write-test-manifest');
  assert.equal(registered[0].ip, probes[0].ip);
  assert.notEqual(registered[0].ip, raw.ip);
});
test('manifest rejects IP literal HTTPS, HTTP and hostname reused across candidates', () => {
  assert.throws(() => loadProbes([{ ...probes[0], url: 'https://104.16.0.1/test' }]));
  assert.throws(() => loadProbes([{ ...probes[0], url: 'http://v4.example.com/test' }]));
  assert.throws(() => loadProbes([probes[0], { ...probes[0], id: 'v4b', ip: '104.16.0.2' }]));
});
test('DNS check refuses dual-stack, multi-IP, alias, wrong IP and non-Cloudflare addresses', async () => {
  const ranges = ['104.16.0.0/13'];
  const mock = (answers: Record<string, { type: number; data: string }[]>) => (async (url: string | URL | Request) => Response.json({ Status: 0, Answer: answers[new URL(String(url)).searchParams.get('type')!] || [] })) as typeof fetch;
  const valid = { '1': [{ type: 1, data: '104.16.0.1' }] };
  await validateProbeDns(probes[0], ranges, mock(valid));
  for (const invalid of [
    { '1': [{ type: 1, data: '104.16.0.2' }] },
    { ...valid, '28': [{ type: 28, data: '2606:4700::1' }] },
    { '1': [...valid['1'], { type: 1, data: '104.16.0.2' }] },
    { ...valid, '65': [{ type: 65, data: '1 . alpn=h3' }] },
    { ...valid, '28': [{ type: 5, data: 'other.example.com' }] }
  ]) await assert.rejects(() => validateProbeDns(probes[0], ranges, mock(invalid)));
  await assert.rejects(() => validateProbeDns({ ...probes[0], ip: '127.0.0.1' }, ranges, mock(valid)), /官方网段/);
});
