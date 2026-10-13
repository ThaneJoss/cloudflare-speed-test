import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import worker from '../src/worker.ts';

const config = JSON.parse(await readFile(new NodeURL('../wrangler.jsonc', import.meta.url), 'utf8'));
const previewOrigin = 'https://branch-preview.example.test';

function previewEnv(reads: PropertyKey[]): Env {
  return new Proxy(config.previews.vars, {
    get(target, property) {
      reads.push(property);
      assert.ok(Object.hasOwn(target, property), `Preview must not access a credential or resource: ${String(property)}`);
      return target[property];
    }
  }) as Env;
}

test('checked-in preview configuration refuses every API before fetching or reading production bindings', async t => {
  const externalFetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected preview network request');
  });
  const reads: PropertyKey[] = [];
  const env = previewEnv(reads);
  const status = await worker.fetch(new Request(`${previewOrigin}/api/status`), env);
  assert.equal(status.status, 503);

  for (const path of ['candidates', 'plan', 'write']) {
    // Even an attacker who can match the configured Origin and supply a token
    // cannot reach authentication networking, probes, the limiter or DNS.
    const response = await worker.fetch(new Request(`${config.previews.vars.APP_ORIGIN}/api/${path}`, {
      method: 'POST',
      headers: { Origin: config.previews.vars.APP_ORIGIN, 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'untrusted-token' },
      body: '{}'
    }), env);
    assert.equal(response.status, 503, path);
  }
  assert.ok(reads.every(name => ['APP_ORIGIN', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'].includes(String(name))));
  assert.equal(externalFetch.mock.callCount(), 0);
});

test('preview POSTs cannot claim their hostname or the production Origin, and previews bind no production resources', async t => {
  const externalFetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected preview network request');
  });
  // Preview variables are intentionally inert; secrets and resource bindings
  // are not copied from production merely to make a branch build succeed.
  assert.deepEqual(Object.keys(config.previews), ['vars']);
  assert.deepEqual(config.previews.vars, {
    APP_ORIGIN: 'https://preview.invalid', CF_ZONE_ID: '', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: ''
  });
  const reads: PropertyKey[] = [];
  for (const origin of [previewOrigin, config.vars.APP_ORIGIN]) {
    const response = await worker.fetch(new Request(`${previewOrigin}/api/write`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}'
    }), previewEnv(reads));
    assert.equal(response.status, 403);
  }
  assert.ok(reads.every(name => name === 'APP_ORIGIN'));
  assert.equal(externalFetch.mock.callCount(), 0);
});
