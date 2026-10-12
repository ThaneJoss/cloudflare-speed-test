import { authenticate, fingerprint, signRun, verifyRun } from './auth.ts';
import { AppError, PROBE_BYTES, ROUNDS, RUN_SECONDS, SAMPLE_SIZE, TARGET, TIMEOUT_MS } from './constants.ts';
import { DnsClient, publicRecords, type DnsRecord } from './dns.ts';
import { cloudflareRanges, loadProbes, readJson, validateProbeDns, type Probe } from './probes.ts';
import { probePoolMessage, sampleProbes, uniqueProbes } from './sampling.ts';
import { getCandidatePoolInfo, sampleCandidateIps } from './candidates.ts';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function getStatus(probes: Probe[], fetchRecords: () => Promise<DnsRecord[]>) {
  const count = uniqueProbes(probes).length;
  const state = { target: TARGET, candidatePool: getCandidatePoolInfo(), probePool: { count, sampleSize: SAMPLE_SIZE, configured: count >= SAMPLE_SIZE, message: probePoolMessage(count) } };
  try { return { ...state, records: publicRecords(await fetchRecords()) }; }
  catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { ...state, records: null, dnsError: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
  }
}

export function getCandidates() {
  return { candidatePool: getCandidatePoolInfo(), candidates: sampleCandidateIps() };
}

export async function getPlan(probes: Probe[], secret: string, subject: string, manifest: string, dependencies: {
  randomUint32?: () => number;
  getRanges?: () => Promise<string[]>;
  validateDns?: typeof validateProbeDns;
} = {}): Promise<Response> {
  const selected = sampleProbes(probes, dependencies.randomUint32);
  const ranges = await (dependencies.getRanges ?? cloudflareRanges)();
  const validateDns = dependencies.validateDns ?? validateProbeDns;
  const rejected: { id: string; error: string }[] = [];
  for (let index = 0; index < selected.length; index += 3) {
    const group = selected.slice(index, index + 3);
    const results = await Promise.allSettled(group.map(probe => validateDns(probe, ranges)));
    results.forEach((result, offset) => {
      if (result.status === 'rejected') rejected.push({ id: group[offset].id, error: result.reason instanceof Error ? result.reason.message : '入口验证失败' });
    });
  }
  if (rejected.length) return json({ error: `本轮随机抽取的 ${SAMPLE_SIZE} 个入口中有 ${rejected.length} 个未通过固定 IP 检查，请修复入口后重新测速。`, code: 'PROBE_SAMPLE_REJECTED', selected, rejected }, 422);
  const runToken = await signRun(secret, subject, selected.map(probe => probe.id), manifest);
  return json({ probes: selected, rejected, sampleSize: SAMPLE_SIZE, runToken, expiresAt: Date.now() + RUN_SECONDS * 1000, rounds: ROUNDS, timeoutMs: TIMEOUT_MS, bytes: PROBE_BYTES, target: TARGET });
}

export function requireOrigin(request: Request, origin: string) {
  if (request.headers.get('Origin') !== origin || new URL(request.url).origin !== origin) throw new AppError(403, '仅允许从测速页面提交操作');
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new AppError(415, '请求必须使用 application/json');
}

export function parseSelection(body: unknown, probes: Probe[], allowed: string[]): { token: string; selected: Probe[] } {
  if (!body || typeof body !== 'object') throw new AppError(400, '请求格式不正确');
  const value = body as Record<string, unknown>;
  if (typeof value.runToken !== 'string' || value.runToken.length > 4096 || !Array.isArray(value.selected) || !value.selected.length || value.selected.length > 2) throw new AppError(400, '请先完成测速');
  const families = new Set<number>();
  const selected = value.selected.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new AppError(400, '无效的测速结果');
    const r = item as Record<string, unknown>;
    const probe = probes.find(p => p.id === r.id && allowed.includes(p.id));
    if (!probe || families.has(probe.family)) throw new AppError(400, '候选不在本次测速清单内，或地址族重复');
    if (r.successes !== ROUNDS || r.attempts !== ROUNDS || typeof r.latencyMs !== 'number' || !Number.isFinite(r.latencyMs) || r.latencyMs <= 0 || r.latencyMs > TIMEOUT_MS || typeof r.mbps !== 'number' || !Number.isFinite(r.mbps) || r.mbps <= 0) throw new AppError(400, '只能写入完成全部测试的候选');
    families.add(probe.family);
    return probe;
  });
  return { token: value.runToken, selected };
}

export async function authorizeSelection(body: unknown, probes: Probe[], secret: string, subject: string, manifest: string): Promise<Probe[]> {
  const selection = parseSelection(body, probes, probes.map(probe => probe.id));
  const allowed = await verifyRun(secret, selection.token, subject, manifest);
  if (selection.selected.some(probe => !allowed.includes(probe.id))) throw new AppError(400, '候选未通过本次入口检查');
  return selection.selected;
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (!path.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
        const probes = loadProbes();
        const asset = await env.ASSETS.fetch(request);
        const response = new Response(asset.body, asset);
        const origins = [...new Set(probes.map(p => new URL(p.url).origin))].join(' ');
        response.headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${origins}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
        response.headers.set('Referrer-Policy', 'no-referrer');
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('Cache-Control', 'no-cache');
        return response;
      }
      const expected = path === '/api/status' ? 'GET' : ['/api/candidates', '/api/plan', '/api/write'].includes(path) ? 'POST' : null;
      if (!expected) return json({ error: 'Not found' }, 404);
      if (request.method !== expected) return json({ error: 'Method not allowed' }, 405);
      if (request.method === 'POST') requireOrigin(request, env.APP_ORIGIN);
      const subject = await authenticate(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      if (path === '/api/candidates') return json(getCandidates());
      const probes = loadProbes();
      if (path === '/api/status') return json(await getStatus(probes, () => new DnsClient(env.CF_ZONE_ID, env.CF_DNS_API_TOKEN).current()));
      if (!(await env.WRITE_LIMITER.limit({ key: `${path}:${subject}` })).success) throw new AppError(429, '操作过于频繁，请在一分钟后重试');
      const manifest = await fingerprint(probes);
      if (path === '/api/plan') return await getPlan(probes, env.RUN_SIGNING_SECRET, subject, manifest);
      const dns = new DnsClient(env.CF_ZONE_ID, env.CF_DNS_API_TOKEN);
      if (Number(request.headers.get('Content-Length') || 0) > 8192) throw new AppError(413, '请求过大');
      let body: unknown;
      try { body = await readJson(new Response(request.body), 8192); } catch { throw new AppError(400, '请求过大或 JSON 无效'); }
      const selected = await authorizeSelection(body, probes, env.RUN_SIGNING_SECRET, subject, manifest);
      const ranges = await cloudflareRanges();
      await Promise.all(selected.map(p => validateProbeDns(p, ranges)));
      const result = await dns.write(selected);
      console.log(JSON.stringify({ event: 'dns_write', target: TARGET, types: selected.map(p => p.family === 4 ? 'A' : 'AAAA'), changed: result.changed }));
      return json({ ...result, target: TARGET, message: result.changed ? 'DNS 已写入并核对，解析缓存可能需要约 5 分钟更新。' : '当前 DNS 已是本次优选结果。' });
    } catch (error) {
      if (error instanceof AppError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
      console.error(JSON.stringify({ event: 'request_failed', path, type: error instanceof Error ? error.name : 'Unknown' }));
      return json({ error: '服务暂时无法完成请求，请稍后重试；若刚执行写入，请先刷新核对 DNS。' }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
