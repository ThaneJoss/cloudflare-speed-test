import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise the production DnsClient in workerd. All upstreams are local fixtures.
const bundle = await build({
  stdin: { contents: `
    import { DnsClient } from './src/dns.ts';
    const probe = { id: 'v4', name: 'fixture', family: 4, ip: '104.16.0.1', url: 'https://v4.example.com/__cfst' };
    export default { async fetch(request) {
      try {
        if (new URL(request.url).pathname === '/old-options') {
          await fetch('https://api.cloudflare.com/fixture', { signal: AbortSignal.timeout(10000), redirect: 'error' });
          return Response.json({ unexpected: true });
        }
        if (new URL(request.url).pathname === '/binding-options') {
          const holder = { fetcher: fetch };
          const options = { signal: AbortSignal.timeout(10000), redirect: 'manual', headers: { Authorization: 'Bearer fake-test-token' } };
          const outcomes = {};
          try { await holder.fetcher('https://api.cloudflare.com/fixture', options); }
          catch (error) { outcomes.method = error.message; }
          const fetcher = holder.fetcher;
          outcomes.standalone = (await fetcher('https://api.cloudflare.com/fixture', options)).status;
          return Response.json(outcomes);
        }
        const dns = new DnsClient('a'.repeat(32), 'fake-test-token');
        const result = new URL(request.url).pathname === '/write' ? await dns.write([probe]) : await dns.current();
        return Response.json({ result });
      } catch (error) {
        return Response.json({ name: error.name, error: error.message, code: error.code }, { status: error.status || 500 });
      }
    } };`, resolveDir: process.cwd(), sourcefile: 'dns-runtime-fixture.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022'
});

let scenario = 'ok';
const calls = [];
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'],
  script: bundle.outputFiles[0].text,
  outboundService(request) {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'api.cloudflare.com');
    assert.equal(request.headers.get('Authorization'), 'Bearer fake-test-token');
    calls.push(request.method);
    if (scenario === 'redirect' || (scenario === 'write-redirect' && request.method === 'POST')) return new Response(null, { status: 307, headers: { Location: 'https://must-not-follow.test/' } });
    if (scenario === 'rejected') return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
    if (scenario === 'invalid') return new Response('<html>fixture</html>');
    return Response.json({ success: true, result: [] });
  }
}));

try {
  const oldResponse = await mf.dispatchFetch('https://worker.test/old-options');
  const old = await oldResponse.json();
  assert.equal(old.name, 'TypeError');
  assert.match(old.error, /Invalid redirect value/);
  assert.equal(calls.length, 0, 'invalid options must fail before any upstream request');
  console.log(`Original request reproduced: ${old.error}`);

  const binding = await (await mf.dispatchFetch('https://worker.test/binding-options')).json();
  console.log('Fetch receiver reproduction:', JSON.stringify(binding));
  assert.match(binding.method, /Illegal invocation/);
  assert.equal(binding.standalone, 200);
  calls.splice(0);

  const fixed = await mf.dispatchFetch('https://worker.test/current');
  assert.equal(fixed.status, 200);
  assert.deepEqual(await fixed.json(), { result: [] });
  assert.deepEqual(calls.splice(0), ['GET']);

  for (const [mode, code, path, expectedCalls] of [
    ['redirect', 'DNS_API_REDIRECT', '/current', ['GET']],
    ['write-redirect', 'DNS_API_REDIRECT', '/write', ['GET', 'POST']],
    ['rejected', 'DNS_API_REJECTED', '/current', ['GET']],
    ['invalid', 'DNS_API_INVALID_RESPONSE', '/current', ['GET']]
  ]) {
    scenario = mode;
    const response = await mf.dispatchFetch(`https://worker.test${path}`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, code);
    assert.deepEqual(calls.splice(0), expectedCalls, 'must not follow redirects or retry writes');
  }
  console.log('PASS: production DnsClient reads successfully in workerd; redirects, API rejection and malformed responses fail safely without retries. No external requests or real DNS writes.');
} finally { await mf.dispose(); }
