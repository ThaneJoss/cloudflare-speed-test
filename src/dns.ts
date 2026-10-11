import { AppError, TARGET, TTL } from './constants.ts';
import { canonical, readJson, type Probe } from './probes.ts';

export type DnsRecord = { id: string; name: string; type: string; content: string; ttl: number; proxied?: boolean; meta?: { managed_by_apps?: boolean; managed_by_argo_tunnel?: boolean }; settings?: { [key: string]: unknown } };
type ApiReply<T> = { success: boolean; result: T; errors?: { code: number; message: string }[]; result_info?: { total_pages?: number } };

function dnsFailure(code: string, message: string, details: Record<string, unknown>): AppError {
  // Never log the Authorization header, token, request body or raw exception text.
  console.error(JSON.stringify({ event: 'dns_api_failed', code, ...details }));
  return new AppError(502, message, code);
}

export class DnsClient {
  zone: string;
  token: string;
  fetcher: typeof fetch;
  constructor(zone: string, token: string, fetcher: typeof fetch = fetch) {
    if (!/^[a-f0-9]{32}$/.test(zone) || !token) throw new AppError(503, '请配置 CF_ZONE_ID 和 CF_DNS_API_TOKEN', 'DNS_CONFIG_MISSING');
    if (/[\r\n]/.test(token)) throw new AppError(503, 'CF_DNS_API_TOKEN 运行时值含换行，无法构造请求头', 'DNS_CONFIG_INVALID');
    this.zone = zone; this.token = token; this.fetcher = fetcher;
  }
  async request<T>(suffix: string, body?: unknown): Promise<ApiReply<T>> {
    const operation = body ? 'write' : 'read';
    // Do not invoke global fetch as a DnsClient method in workerd.
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4/zones/${this.zone}/dns_records${suffix}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        // workerd rejects redirect: 'error' before sending the request.
        // Return redirects for explicit rejection; never forward the Bearer token.
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000), redirect: 'manual'
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Unknown';
      const timeout = ['AbortError', 'TimeoutError'].includes(name);
      const code = timeout ? 'DNS_API_TIMEOUT' : 'DNS_API_CONNECTION_FAILED';
      throw dnsFailure(code, body ? 'Cloudflare 请求中断，写入状态不确定；请刷新核对当前 DNS 后再试' : timeout ? 'Cloudflare DNS API 请求超时' : '无法连接 Cloudflare DNS API', {
        operation, type: ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(name) ? name : 'Unknown'
      });
    }
    const details = { operation, upstreamStatus: response.status, upstreamRay: response.headers.get('CF-Ray') };
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw dnsFailure('DNS_API_REDIRECT', 'Cloudflare DNS API 返回了意外重定向，已停止请求', details);
    }
    let data: ApiReply<T>;
    try {
      data = await readJson<ApiReply<T>>(response);
      if (!data || typeof data !== 'object' || typeof data.success !== 'boolean') throw new Error('Invalid API envelope');
    } catch {
      throw dnsFailure('DNS_API_INVALID_RESPONSE', `Cloudflare DNS API 返回了无效响应（HTTP ${response.status}）`, details);
    }
    if (!response.ok || !data.success) {
      const apiErrors = Array.isArray(data.errors) ? data.errors : [];
      const errors = apiErrors.map(e => `${e.code}: ${String(e.message).replaceAll(this.token, '[redacted]')}`).join('；').slice(0, 500) || `HTTP ${response.status}`;
      throw dnsFailure('DNS_API_REJECTED', `Cloudflare DNS API 拒绝操作：${errors}`, { ...details, upstreamCodes: apiErrors.map(e => e.code).filter(code => typeof code === 'number') });
    }
    return data;
  }
  async current(): Promise<DnsRecord[]> {
    const data = await this.request<DnsRecord[]>(`?name=${encodeURIComponent(TARGET)}&per_page=100`);
    if (!Array.isArray(data.result) || (data.result_info?.total_pages ?? 1) > 1) throw new AppError(409, '同名记录过多，请先在 Cloudflare 控制台整理');
    return data.result.filter(r => r.name.toLowerCase().replace(/\.$/, '') === TARGET);
  }
  async write(selected: Probe[]) {
    const before = await this.current();
    const { patches, posts } = planChanges(before, selected);
    if (patches.length || posts.length) await this.request('/batch', { patches, posts });
    let after: DnsRecord[];
    try { after = await this.current(); }
    catch { throw new AppError(502, '写入请求已接受，但读取验证失败；请刷新核对当前 DNS'); }
    for (const probe of selected) {
      const type = probe.family === 4 ? 'A' : 'AAAA';
      const records = after.filter(r => r.type === type);
      if (records.length !== 1 || canonical(records[0].content) !== probe.ip || records[0].proxied !== false || records[0].ttl !== TTL) throw new AppError(409, '写入后的 DNS 状态与预期不同，请刷新核对；可能有其他管理员同时修改');
    }
    return { changed: patches.length + posts.length > 0, records: publicRecords(after) };
  }
}

export function publicRecords(records: DnsRecord[]) {
  return records.filter(r => ['A', 'AAAA', 'CNAME'].includes(r.type)).map(({ type, content, proxied, ttl }) => ({ type, content, proxied, ttl }));
}

export function planChanges(records: DnsRecord[], selected: Probe[]) {
  if (!selected.length || selected.length > 2 || new Set(selected.map(p => p.family)).size !== selected.length) throw new AppError(400, '每个地址族最多选择一个候选');
  if (records.some(r => ['CNAME', 'NS'].includes(r.type))) throw new AppError(409, '目标存在 CNAME 或 NS 记录，请先手动处理冲突');
  const patches: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  for (const probe of selected) {
    const type = probe.family === 4 ? 'A' : 'AAAA';
    const existing = records.filter(r => r.type === type);
    if (existing.length > 1) throw new AppError(409, `目标存在多条 ${type} 记录，请先手动保留一条`);
    const record = existing[0];
    if (record?.meta?.managed_by_apps || record?.meta?.managed_by_argo_tunnel) throw new AppError(409, '目标记录由其他 Cloudflare 服务管理，不能覆盖');
    const change = { name: TARGET, type, content: probe.ip, proxied: false, ttl: TTL };
    if (!record) posts.push(change);
    else if (canonical(record.content) !== probe.ip || record.proxied !== false || record.ttl !== TTL) patches.push({ id: record.id, ...change });
  }
  return { patches, posts };
}
