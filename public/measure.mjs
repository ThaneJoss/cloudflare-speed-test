export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function pickBest(results, family) {
  const good = results.filter(r => r.family === family && r.successes === r.attempts && r.attempts >= 3 && r.latencyMs > 0 && r.mbps > 0 && !r.error);
  if (!good.length) return null;
  const fastest = Math.min(...good.map(r => r.latencyMs));
  // Latency first; among candidates within 15%, prefer greater measured throughput.
  return good.filter(r => r.latencyMs <= fastest * 1.15).sort((a, b) => b.mbps - a.mbps || a.latencyMs - b.latencyMs || a.id.localeCompare(b.id))[0];
}

export async function sample(probe, bytes, timeoutMs, fetcher = fetch) {
  const nonce = crypto.randomUUID();
  const url = new URL(probe.url);
  url.searchParams.set('bytes', String(bytes));
  url.searchParams.set('nonce', nonce);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetcher(url.href, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
    const headersAt = performance.now();
    if (response.status !== 200 || response.type === 'opaque') throw new Error(`入口未返回可验证的 HTTP 200（${response.status}）`);
    if (response.headers.get('X-CFST-ID') !== probe.id || response.headers.get('X-CFST-Nonce') !== nonce) throw new Error('入口标识不匹配、CORS 配置缺失或命中缓存');
    const encoding = response.headers.get('Content-Encoding');
    if (encoding && encoding !== 'identity') throw new Error('测速响应经过压缩，无法准确比较');
    const alt = response.headers.get('Alt-Svc');
    if (alt && alt !== 'clear') throw new Error('入口含 Alt-Svc 替代路由，请先禁用');
    if (!response.body) throw new Error('入口返回空响应');
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > bytes) throw new Error('入口返回的数据超过预定大小');
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const elapsed = performance.now() - started;
    if (size !== bytes) throw new Error('下载不完整或入口返回了错误内容');
    return { latencyMs: headersAt - started, elapsedMs: elapsed, mbps: size * 8 / Math.max(elapsed, 0.001) / 1000 };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接或下载超时');
    throw error;
  } finally { controller.abort(); clearTimeout(timeout); }
}

export async function measureProbe(probe, plan, onStep = () => {}, sampleFn = sample) {
  const samples = [];
  const errors = [];
  // First request includes the initial DNS / TLS cost; later requests may reuse the connection.
  for (let i = 0; i < plan.rounds; i++) {
    try { samples.push(await sampleFn(probe, 1024, plan.timeoutMs)); }
    catch (error) { errors.push(error.message || '连接失败'); }
    onStep();
  }
  let download = null;
  if (samples.length === plan.rounds) {
    try { download = await sampleFn(probe, plan.bytes, plan.timeoutMs); }
    catch (error) { errors.push(error.message || '下载失败'); }
  }
  onStep();
  return { ...probe, successes: samples.length, attempts: plan.rounds, latencyMs: median(samples.map(s => s.latencyMs)), mbps: download?.mbps ?? null, error: errors[0] || null };
}
