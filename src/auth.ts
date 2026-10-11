import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { AppError, RUN_SECONDS } from './constants.ts';

export async function authenticate(request: Request, team: string, audience: string): Promise<string> {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !audience) throw new AppError(503, '请先配置 Cloudflare Access 的团队域名和 AUD');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) throw new AppError(401, '请先通过 Cloudflare Access 登录');
  try {
    const issuer = `https://${team}`;
    const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'], clockTolerance: 5 });
    if (!payload.sub) throw new Error('No subject');
    return payload.sub;
  } catch { throw new AppError(401, '登录验证失败，请刷新页面重新登录'); }
}

function key(secret: string): Uint8Array {
  if (!secret || secret.length < 32) throw new AppError(503, '请配置至少 32 字符的 RUN_SIGNING_SECRET');
  return new TextEncoder().encode(secret);
}

export async function signRun(secret: string, subject: string, ids: string[], manifest: string): Promise<string> {
  return new SignJWT({ ids, manifest }).setProtectedHeader({ alg: 'HS256' }).setIssuer('cf-speed-test').setAudience('dns-write').setSubject(subject).setIssuedAt().setExpirationTime(`${RUN_SECONDS}s`).setJti(crypto.randomUUID()).sign(key(secret));
}

export async function verifyRun(secret: string, token: string, subject: string, manifest: string): Promise<string[]> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: 'cf-speed-test', audience: 'dns-write', subject, algorithms: ['HS256'], requiredClaims: ['exp', 'iat', 'jti'] });
    if (payload.manifest !== manifest || !Array.isArray(payload.ids) || !payload.ids.every(id => typeof id === 'string')) throw new Error('Invalid manifest');
    return payload.ids;
  } catch { throw new AppError(409, '测速结果已过期或配置已变更，请重新测速'); }
}

export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
