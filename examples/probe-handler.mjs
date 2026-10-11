/**
 * Add this response handler to an EXISTING HTTPS endpoint whose DNS is pinned to
 * one candidate IP. Deploying it to a normal Worker Custom Domain does not pin IPs.
 * Configure a unique PROBE_ID per hostname, matching probes.json.
 */
export default {
  fetch(request, env) {
    const origin = 'https://cf-speed-test.thanejoss.com';
    const url = new URL(request.url);
    if (url.pathname !== '/__cfst' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    if (request.headers.get('Origin') && request.headers.get('Origin') !== origin) return new Response('Forbidden', { status: 403 });
    const bytes = Number(url.searchParams.get('bytes'));
    const nonce = url.searchParams.get('nonce') || '';
    if (![1024, 262144].includes(bytes) || !/^[a-f0-9-]{36}$/.test(nonce) || !/^[a-z0-9-]{1,40}$/.test(env.PROBE_ID || '')) return new Response('Invalid probe', { status: 400 });
    const data = new Uint8Array(bytes);
    for (let offset = 0; offset < bytes; offset += 65536) crypto.getRandomValues(data.subarray(offset, Math.min(offset + 65536, bytes)));
    return new Response(data, { headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes),
      'Cache-Control': 'no-store, no-transform',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Expose-Headers': 'X-CFST-ID, X-CFST-Nonce, Content-Encoding, Alt-Svc',
      'Timing-Allow-Origin': origin,
      'Alt-Svc': 'clear',
      'X-CFST-ID': env.PROBE_ID,
      'X-CFST-Nonce': nonce,
      'X-Content-Type-Options': 'nosniff'
    } });
  }
};
