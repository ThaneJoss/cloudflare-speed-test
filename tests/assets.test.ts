import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.ts';

const origin = 'https://cf-speed-test.thanejoss.com';

test('static GET and HEAD preserve asset responses and apply the page security headers', async t => {
  const externalFetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected external request');
  });
  const requests: Request[] = [];
  const assets: Pick<Fetcher, 'fetch'> = {
    async fetch(input) {
      assert.ok(input instanceof Request);
      requests.push(input);
      return new Response(input.method === 'HEAD' ? null : 'fixture asset', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: 'fixture-etag', 'Cache-Control': 'public, max-age=3600' }
      });
    }
  };
  // Only the static-assets binding is needed on this path.
  const env = { ASSETS: assets } as Env;
  for (const method of ['GET', 'HEAD']) {
    const request: Parameters<typeof worker.fetch>[0] = new Request(`${origin}/`, { method });
    const response = await worker.fetch(request, env);
    assert.equal(requests.at(-1), request);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'fixture asset');
    assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('ETag'), 'fixture-etag');
    assert.equal(response.headers.get('Cache-Control'), 'no-cache');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    const directives = response.headers.get('Content-Security-Policy')?.split(';').map(value => value.trim());
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) {
      assert.ok(directives?.includes(directive), `Missing CSP directive: ${directive}`);
    }
  }
  assert.equal(requests.length, 2);
  assert.equal(externalFetch.mock.callCount(), 0);
});

test('unsupported static methods and API routes stop before accessing bindings or authentication', async t => {
  const externalFetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected external request');
  });
  const bindingsRead: PropertyKey[] = [];
  const env = new Proxy({} as Env, {
    get(_target, property) {
      bindingsRead.push(property);
      throw new Error(`Unexpected binding access: ${String(property)}`);
    }
  });
  const cases = [
    { path: '/', method: 'POST', status: 405, error: 'Method not allowed' },
    { path: '/api/missing', method: 'GET', status: 404, error: 'Not found' },
    { path: '/api/missing', method: 'POST', status: 404, error: 'Not found' },
    { path: '/api/status', method: 'POST', status: 405, error: 'Method not allowed' },
    ...['candidates', 'plan', 'write'].map(path => ({ path: `/api/${path}`, method: 'GET', status: 405, error: 'Method not allowed' }))
  ];
  for (const fixture of cases) {
    const response = await worker.fetch(new Request(`${origin}${fixture.path}`, { method: fixture.method }), env);
    assert.equal(response.status, fixture.status, `${fixture.method} ${fixture.path}`);
    assert.deepEqual(await response.json(), { error: fixture.error });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  }
  assert.deepEqual(bindingsRead, []);
  assert.equal(externalFetch.mock.callCount(), 0);
});
