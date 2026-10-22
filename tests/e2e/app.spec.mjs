import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const origin = 'http://127.0.0.1:4173';
const candidatePool = {
  checkedAt: '2026-10-12', cidrCounts: { ipv4: 15, ipv6: 7 },
  distribution: { ipv4: 10, ipv6: 10 }, sampleSize: 20
};
const candidates = [4, 6].flatMap(family => Array.from({ length: 10 }, (_, i) => ({
  family, ip: family === 4 ? `104.16.0.${i + 1}` : `2606:4700:1234:5678:abcd:1234:5678:${i + 1}`,
  cidr: family === 4 ? '104.16.0.0/13' : '2606:4700::/32', reachability: 'unknown'
})));
const probes = Array.from({ length: 10 }, (_, i) => ({
  id: `v4-${i}`, name: `测试入口 ${i + 1}`, family: 4,
  ip: `104.16.0.${i + 1}`, url: `https://probe-${i}.example.test/__cfst`
}));

const test = base.extend({
  app: async ({ page, context }, use) => {
    const unexpected = [];
    const errors = [];
    const calls = [];
    const requests = [];
    const writes = [];
    let generation = 0;
    let settings = {};
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (body, status = 200) => route.fulfill({ status, json: body });
      if (url.origin === origin) {
        if (['/', '/style.css', '/app.mjs', '/measure.mjs', '/favicon.svg'].includes(url.pathname)) {
          await route.continue();
          return;
        }
        calls.push(url.pathname);
        if (settings.unauthorized) return json({ error: '请登录后重试' }, 401);
        if (url.pathname === '/api/candidates') {
          generation++;
          return json({ candidatePool, candidates: candidates.map(candidate => ({
            ...candidate, ip: candidate.family === 4 ? candidate.ip.replace('104.16.', `104.${15 + generation}.`) : candidate.ip
          })) });
        }
        if (url.pathname === '/api/status') return json({
          candidatePool,
          probePool: { configured: Boolean(settings.configured), count: settings.configured ? 10 : 0, sampleSize: 10, message: '请配置 probes.json 中的真实 HTTPS 探针。' },
          records: settings.dnsError ? null : [],
          ...(settings.dnsError ? { dnsError: { error: 'DNS unavailable' } } : {})
        });
        if (url.pathname === '/api/plan') {
          if (settings.rejectPlan) return json({
            error: '本轮入口验证未通过', selected: probes,
            rejected: [{ id: probes[0].id, error: '候选 DNS 未固定到指定 IP' }]
          }, 422);
          return json({ probes, rounds: 3, bytes: 262144, timeoutMs: 6000, expiresAt: Date.now() + 600000, runToken: 'local-fixture-token' });
        }
        if (url.pathname === '/api/write') {
          const body = request.postDataJSON();
          writes.push(body);
          const probe = probes.find(item => item.id === body.selected[0].id);
          return json({ records: [{ type: 'A', content: probe.ip, proxied: false, ttl: 300 }], message: 'DNS 已写入并核对（本地模拟）。' });
        }
      }
      const probe = probes.find(item => new URL(item.url).origin === url.origin);
      if (probe && url.pathname === '/__cfst') {
        const bytes = Number(url.searchParams.get('bytes'));
        requests.push({ id: probe.id, bytes });
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': origin,
            'Access-Control-Expose-Headers': 'X-CFST-ID, X-CFST-Nonce, Alt-Svc',
            'X-CFST-ID': probe.id, 'X-CFST-Nonce': url.searchParams.get('nonce'),
            'Cache-Control': 'no-store, no-transform', 'Alt-Svc': 'clear'
          },
          body: Buffer.alloc(bytes, 37)
        });
        return;
      }
      // Fail closed: no external DNS, probes, writes, or other network traffic.
      unexpected.push(request.url());
      await route.abort('blockedbyclient');
    });
    await use({
      calls, requests, writes,
      async open(options = {}) { settings = options; await page.goto('/'); }
    });
    expect(unexpected, 'only loopback assets and intercepted fixtures may be requested').toEqual([]);
    expect(errors, 'page must not throw uncaught errors').toEqual([]);
  }
});

async function checkAccessibility(page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
  expect(await page.locator('html').evaluate(html => html.scrollWidth <= html.ownerDocument.defaultView.innerWidth)).toBe(true);
}

test('unconfigured probes keep independent candidates usable and support keyboard/mobile access', async ({ page, app }, testInfo) => {
  await app.open({ dnsError: true });
  await expect(page.locator('#candidates tr')).toHaveCount(20);
  await expect(page.locator('#status')).toContainText('probes.json');
  await expect(page.locator('#status')).toContainText('DNS unavailable');
  await expect(page.locator('#test')).toBeDisabled();
  await expect(page.locator('#write')).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  const region = page.getByRole('region', { name: '静态 IP 候选表格', exact: true });
  await region.focus();
  await expect(region).toBeFocused();
  await expect(region).toHaveCSS('outline-style', 'solid');
  await page.locator('#generate').click();
  await expect(page.locator('#candidates tr').first()).toContainText('104.17.0.1');
  await expect(page.locator('#test')).toBeDisabled();
  await expect(page.locator('#write')).toBeDisabled();
  await page.getByText('当前 DNS 记录', { exact: false }).click();
  await expect(page.locator('#current')).toHaveText('暂时无法读取。');
  expect(app.calls.filter(path => path === '/api/candidates')).toHaveLength(2);
  expect(app.requests).toHaveLength(0);
  expect(app.writes).toHaveLength(0);
  await checkAccessibility(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('candidates.png'), fullPage: true });
  await testInfo.attach('候选与空探针状态', { path: testInfo.outputPath('candidates.png'), contentType: 'image/png' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await checkAccessibility(page);
  await expect(page.locator('#generate')).toHaveCSS('transition-duration', '0s');
});

test('real browser measurement enables a fixture DNS write only after all ten probes finish', async ({ page, app }, testInfo) => {
  await app.open({ configured: true });
  await expect(page.locator('#test')).toBeEnabled();
  await expect(page.locator('#write')).toBeDisabled();
  await page.locator('#test').click();
  await expect(page.locator('#phase')).toHaveText('测速完成');
  await expect(page.locator('#results tr')).toHaveCount(10);
  await expect(page.locator('#v6-ip')).toHaveText('本轮未抽到 IPv6');
  await expect(page.locator('#progress')).toHaveJSProperty('value', 40);
  expect(app.requests).toHaveLength(40);
  for (const probe of probes) {
    expect(app.requests.filter(request => request.id === probe.id).map(request => request.bytes)).toEqual([1024, 1024, 1024, 262144]);
  }
  await expect(page.locator('#write')).toBeEnabled();
  await checkAccessibility(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('measurement.png'), fullPage: true });
  await testInfo.attach('模拟测速完成', { path: testInfo.outputPath('measurement.png'), contentType: 'image/png' });
  await page.locator('#write').click();
  await expect(page.locator('#phase')).toHaveText('写入完成');
  await expect(page.locator('#write')).toBeDisabled();
  expect(app.writes).toHaveLength(1);
  expect(app.writes[0].runToken).toBe('local-fixture-token');
  expect(app.writes[0].selected).toHaveLength(1);
  expect(app.writes[0].selected[0]).toMatchObject({ successes: 3, attempts: 3 });
  expect(probes.map(probe => probe.id)).toContain(app.writes[0].selected[0].id);
  await page.locator('summary').click();
  await expect(page.locator('#current')).toContainText('DNS only · TTL 300');
});

test('rejected plans expose the selected entries without sending probes or allowing writes', async ({ page, app }) => {
  await app.open({ configured: true, rejectPlan: true });
  await page.locator('#test').click();
  await expect(page.locator('#phase')).toHaveText('测速未完成');
  await expect(page.locator('#results tr')).toHaveCount(10);
  await expect(page.locator('#results tr').first()).toContainText('候选 DNS 未固定到指定 IP');
  await expect(page.locator('#write')).toBeDisabled();
  expect(app.requests).toHaveLength(0);
  expect(app.writes).toHaveLength(0);
  await checkAccessibility(page);
});

test('expired access reports login and leaves all actions disabled', async ({ page, app }) => {
  await app.open({ unauthorized: true });
  await expect(page.locator('#phase')).toHaveText('请登录');
  await expect(page.locator('#candidate-status')).toContainText('请登录');
  for (const id of ['generate', 'test', 'write']) await expect(page.locator(`#${id}`)).toBeDisabled();
  expect(app.requests).toHaveLength(0);
  expect(app.writes).toHaveLength(0);
  await checkAccessibility(page);
});
