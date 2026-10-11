import { measureProbe, pickBest } from './measure.mjs';

const $ = (id) => document.getElementById(id);
let busy = false;
let ready = false;
let dnsReady = false;
let plan = null;
let winners = [];
let expiresTimer = null;
let interrupted = false;

function status(text, kind = '') { $('status').textContent = text; $('status').className = `status ${kind}`; }
function phase(text) { $('phase').textContent = text; }
function buttons() { $('test').disabled = busy || !ready; $('write').disabled = busy || !dnsReady || !winners.length || !plan || Date.now() >= plan.expiresAt; }
function showRecords(records) {
  $('current').replaceChildren();
  if (records === null) { $('current').textContent = '暂时无法读取。'; return; }
  if (!records.length) { $('current').textContent = '尚无记录，首次写入时会创建。'; return; }
  for (const r of records) { const line = document.createElement('div'); line.textContent = `${r.type} · ${r.content} · ${r.proxied ? '已代理' : 'DNS only'} · TTL ${r.ttl}`; $('current').append(line); }
}
function showWinner(family, result, done = true, sampled = true) {
  const prefix = family === 4 ? 'v4' : 'v6';
  $(`${prefix}-ip`).textContent = result?.ip || (!sampled ? `本轮未抽到 IPv${family}` : done ? '无可用结果' : '测速中…');
  $(`${prefix}-latency`).textContent = result ? `${result.latencyMs.toFixed(0)} ms` : '— ms';
  $(`${prefix}-speed`).textContent = result ? `${result.mbps.toFixed(2)} Mbps` : '— Mbps';
}
function addResult(result) {
  const row = document.createElement('tr');
  const name = document.createElement('td'); name.textContent = result.name;
  const address = document.createElement('small'); address.textContent = result.ip; name.append(address); row.append(name);
  const fields = [result.latencyMs ? `${result.latencyMs.toFixed(0)} ms` : '—', result.mbps ? `${result.mbps.toFixed(2)} Mbps` : '—', `${result.successes}/${result.attempts}`, result.error || '可用'];
  for (const field of fields) { const cell = document.createElement('td'); cell.textContent = field; row.append(cell); }
  $('results').append(row);
}
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(60000), redirect: 'error' });
  const body = await response.json().catch(() => ({ error: '登录可能已过期，请刷新页面' }));
  if (!response.ok) {
    const error = new Error([body.error || `HTTP ${response.status}`, ...(body.rejected || []).map(p => p.error)].join('；'));
    error.status = response.status; error.code = body.code; error.selected = body.selected; error.rejected = body.rejected;
    throw error;
  }
  return body;
}

document.addEventListener('visibilitychange', () => { if (busy && document.hidden) interrupted = true; });
window.addEventListener('offline', () => { if (busy) interrupted = true; winners = []; buttons(); });

$('test').addEventListener('click', async () => {
  busy = true; winners = []; plan = null; interrupted = false; clearTimeout(expiresTimer); buttons();
  $('results').replaceChildren(); $('results-section').hidden = true; $('progress').hidden = true;
  showWinner(4, null, false); showWinner(6, null, false);
  phase('检查入口'); status('正在验证候选域名与固定 IP…');
  try {
    plan = await api('/api/plan', {});
    if (document.hidden || interrupted) throw new Error('页面进入后台，本次结果已作废。请回到页面重新测速。');
    $('results-section').hidden = false; $('progress').hidden = false; $('progress').value = 0;
    showWinner(4, null, false, plan.probes.some(p => p.family === 4));
    showWinner(6, null, false, plan.probes.some(p => p.family === 6));
    $('progress').max = plan.probes.length * (plan.rounds + 1);
    const results = [];
    // Serial downloads avoid competing for the user's available bandwidth.
    const ordered = plan.probes.map(p => ({ p, order: crypto.getRandomValues(new Uint32Array(1))[0] })).sort((a,b) => a.order - b.order).map(({p}) => p);
    phase('测速中');
    for (const probe of ordered) {
      status(`正在测试 ${probe.name} · IPv${probe.family}，请保持页面在前台…`);
      const result = await measureProbe(probe, plan, () => { $('progress').value += 1; });
      results.push(result); addResult(result);
      if (interrupted || document.hidden) throw new Error('页面进入后台或网络中断，本次结果已作废，请重新测速。');
    }
    winners = [pickBest(results, 4), pickBest(results, 6)].filter(Boolean);
    showWinner(4, winners.find(r => r.family === 4), true, plan.probes.some(p => p.family === 4)); showWinner(6, winners.find(r => r.family === 6), true, plan.probes.some(p => p.family === 6));
    if (Date.now() >= plan.expiresAt) { winners = []; throw new Error('本轮测速用时过长，结果已过期，请重新测速。'); }
    if (winners.length) {
      phase(dnsReady ? '测速完成' : '测速完成 / DNS 待恢复');
      status(dnsReady ? `已选出 ${winners.length} 个优选地址，点击“写入”更新 DNS。${winners.length === 1 ? '另一地址族的现有记录将保留。' : ''}` : `已选出 ${winners.length} 个优选地址。当前 DNS 无法读取，写入不可用；请恢复 DNS API 后刷新页面重新测速。`, dnsReady ? 'success' : 'error');
      expiresTimer = setTimeout(() => { winners = []; buttons(); phase('结果已过期'); status('本次结果已过期，请重新测速。'); }, Math.max(0, plan.expiresAt - Date.now()));
    } else { phase('暂无可用入口'); status('候选入口未完成全部测试。请查看结果中的原因，检查 IPv6、证书和 CORS 配置后重试。', 'error'); }
  } catch (error) {
    winners = []; showWinner(4, null); showWinner(6, null); phase('测速未完成');
    if (Array.isArray(error.selected)) {
      $('results-section').hidden = false;
      showWinner(4, null, true, error.selected.some(p => p.family === 4)); showWinner(6, null, true, error.selected.some(p => p.family === 6));
      for (const probe of error.selected) addResult({ ...probe, latencyMs: null, mbps: null, successes: 0, attempts: 0, error: error.rejected.find(p => p.id === probe.id)?.error || '本轮验证未全部通过，未测速' });
    }
    status(error.message || '测速失败，请刷新后重试。', 'error');
  }
  finally { busy = false; buttons(); }
});

$('write').addEventListener('click', async () => {
  if (busy || !dnsReady || !plan || !winners.length || Date.now() >= plan.expiresAt) return;
  busy = true; buttons(); clearTimeout(expiresTimer); phase('写入中'); status('正在更新并核对 DNS 记录…');
  try {
    const selected = winners.map(({ id, successes, attempts, latencyMs, mbps }) => ({ id, successes, attempts, latencyMs, mbps }));
    const result = await api('/api/write', { runToken: plan.runToken, selected });
    showRecords(result.records); phase('写入完成'); status(result.message, 'success');
  } catch (error) { phase('请核对 DNS'); status(`${error.message || '写入请求失败。'} 若请求中断，请刷新核对当前记录。`, 'error'); }
  finally { winners = []; plan = null; busy = false; buttons(); }
});

try {
  const state = await api('/api/status');
  ready = state.configured === true; dnsReady = !state.dnsError && Array.isArray(state.records); showRecords(state.records);
  const dnsMessage = state.dnsError ? `当前 DNS 读取失败：${state.dnsError.error}。` : '';
  phase(!ready ? '等待配置' : dnsReady ? '准备就绪' : '可测速 / DNS 待恢复');
  status(!ready ? `${state.message}${dnsMessage}` : dnsReady ? `池中有 ${state.candidates} 个不同 IP，每次点击“测速”重新随机抽取 ${state.sampleSize} 个。` : `池中有 ${state.candidates} 个不同 IP，可随机测速 ${state.sampleSize} 个。${dnsMessage}写入暂不可用。`, ready && dnsReady ? '' : 'error');
} catch (error) { phase(error.status === 401 ? '请登录' : '无法读取状态'); status(error.message || '无法读取配置，请刷新重试。', 'error'); $('current').textContent = '暂时无法读取。'; }
buttons();
