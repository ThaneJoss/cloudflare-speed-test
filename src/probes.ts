import ipaddr from 'ipaddr.js';
import candidates from '../probes.json' with { type: 'json' };
import { AppError } from './constants.ts';

export type Probe = { id: string; name: string; ip: string; url: string; family: 4 | 6 };
type DnsAnswer = { type: number; data: string };
type DnsReply = { Status: number; Answer?: DnsAnswer[] };

export function canonical(ip: string): string {
  if (typeof ip !== 'string' || ip.includes('%') || !ipaddr.isValid(ip)) throw new AppError(400, 'IP 地址无效');
  const parsed = ipaddr.parse(ip);
  if (parsed.kind() === 'ipv4' && !ipaddr.IPv4.isValidFourPartDecimal(ip)) throw new AppError(400, 'IPv4 必须使用标准点分十进制');
  return parsed.toString();
}

export function loadProbes(source: unknown = candidates): Probe[] {
  if (!Array.isArray(source) || source.length > 12) throw new AppError(503, '候选入口配置无效，最多允许 12 个');
  const ids = new Set<string>();
  const hosts = new Set<string>();
  return source.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new AppError(503, '候选入口配置无效');
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.id) || ids.has(p.id)) throw new AppError(503, '候选 ID 无效或重复');
    if (typeof p.name !== 'string' || !p.name || p.name.length > 60 || typeof p.url !== 'string' || typeof p.ip !== 'string') throw new AppError(503, '候选入口字段缺失');
    let url: URL;
    try { url = new URL(p.url); } catch { throw new AppError(503, '测速 URL 无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search || ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || hosts.has(url.hostname)) throw new AppError(503, '每个候选必须使用独立的 HTTPS 域名（443 端口，无查询参数）');
    const ip = canonical(p.ip);
    const family = ipaddr.parse(ip).kind() === 'ipv4' ? 4 : 6;
    ids.add(p.id); hosts.add(url.hostname);
    return { id: p.id, name: p.name, ip, url: url.href, family };
  });
}

export async function readJson<T>(response: Response, limit = 524288): Promise<T> {
  if (!response.body) throw new AppError(502, '服务返回空响应');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new AppError(502, '服务响应超过限制');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)) as T; }
  catch { throw new AppError(502, '服务未返回有效 JSON'); }
}

export async function cloudflareRanges(fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher('https://api.cloudflare.com/client/v4/ips', { signal: AbortSignal.timeout(8000) });
  const data = await readJson<{ success: boolean; result: { ipv4_cidrs: string[]; ipv6_cidrs: string[] } }>(response);
  if (!response.ok || !data.success || !Array.isArray(data.result?.ipv4_cidrs) || !Array.isArray(data.result?.ipv6_cidrs)) throw new AppError(502, '无法验证 Cloudflare IP 范围');
  return [...data.result.ipv4_cidrs, ...data.result.ipv6_cidrs];
}

export function inRanges(ip: string, ranges: string[]): boolean {
  const address = ipaddr.parse(ip);
  return ranges.some((cidr) => {
    const [network, bits] = ipaddr.parseCIDR(cidr);
    return address.kind() === network.kind() && address.match(network, bits);
  });
}

export async function validateProbeDns(probe: Probe, ranges: string[], fetcher: typeof fetch = fetch): Promise<void> {
  if (!inRanges(probe.ip, ranges)) throw new AppError(422, `${probe.name}：IP 不在 Cloudflare 官方网段内`);
  const host = new URL(probe.url).hostname;
  const replies = await Promise.all([1, 28, 65].map(async (type) => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', host); url.searchParams.set('type', String(type));
    const response = await fetcher(url.href, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
    const result = await readJson<DnsReply>(response, 65536);
    if (!response.ok || result.Status !== 0) throw new AppError(422, `${probe.name}：DNS 查询失败`);
    return result.Answer ?? [];
  }));
  const answers = replies.flat();
  if (answers.some(a => [5, 39, 64, 65].includes(a.type))) throw new AppError(422, `${probe.name}：入口含 CNAME / HTTPS 别名，无法确认固定 IP`);
  const addresses = [...new Set(answers.filter(a => [1, 28].includes(a.type)).map(a => canonical(a.data)))];
  if (addresses.length !== 1 || addresses[0] !== probe.ip) throw new AppError(422, `${probe.name}：DNS 必须只解析到配置的单个 IPv${probe.family} 地址`);
}
