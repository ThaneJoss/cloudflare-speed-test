import { cloudflareRanges, loadProbes, validateProbeDns } from '../src/probes.ts';
import { sample } from '../public/measure.mjs';

// This is a deployment prerequisite check, not a speed ranking for the user's network.
const probes = loadProbes();
if (!probes.length) {
  console.error('probes.json 为空。请先配置真实的固定 HTTPS 入口，参见 README。');
  process.exitCode = 1;
} else {
  const ranges = await cloudflareRanges();
  for (const probe of probes) {
    try {
      await validateProbeDns(probe, ranges);
      await sample(probe, 1024, 10000, async (url, options) => {
        const response = await fetch(url, { ...options, headers: { Origin: 'https://cf-speed-test.thanejoss.com' } });
        const origin = response.headers.get('Access-Control-Allow-Origin');
        if (!['*', 'https://cf-speed-test.thanejoss.com'].includes(origin)) { await response.body?.cancel(); throw new Error('缺少正确的 Access-Control-Allow-Origin'); }
        const expose = (response.headers.get('Access-Control-Expose-Headers') || '').toLowerCase().split(',').map(h => h.trim());
        if (!expose.includes('*') && !['x-cfst-id', 'x-cfst-nonce', 'content-encoding', 'alt-svc'].every(h => expose.includes(h))) { await response.body?.cancel(); throw new Error('缺少 Access-Control-Expose-Headers'); }
        if (!(response.headers.get('Cache-Control') || '').includes('no-store')) { await response.body?.cancel(); throw new Error('入口必须设置 Cache-Control: no-store'); }
        return response;
      });
      console.log(`通过：${probe.id} IPv${probe.family} ${probe.ip}`);
    } catch (error) { console.error(`失败：${probe.id} — ${error.message}`); process.exitCode = 1; }
  }
}
