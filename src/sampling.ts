import { AppError, SAMPLE_SIZE } from './constants.ts';
import { canonical, type Probe } from './probes.ts';

export function uniqueProbes(probes: Probe[]): Probe[] {
  const pool = new Map<string, Probe>();
  for (const probe of probes) {
    const ip = canonical(probe.ip);
    if (!pool.has(ip)) pool.set(ip, probe);
  }
  return [...pool.values()];
}

export function probePoolMessage(count: number): string {
  return count === 0 ? `当前候选池有 0 个不同 IP，每轮需要 ${SAMPLE_SIZE} 个。请按 README 填写 probes.json 并验证真实 HTTPS 入口。` : count < SAMPLE_SIZE ? `当前候选池只有 ${count} 个不同 IP，本轮需要随机抽取 ${SAMPLE_SIZE} 个；请补充真实固定 IP HTTPS 入口。` : '';
}

function randomUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function randomIndex(bound: number, nextUint32: () => number): number {
  // Discard the incomplete remainder so every index has the same probability.
  const upperExclusive = Math.floor(0x1_0000_0000 / bound) * bound;
  let value: number;
  do { value = nextUint32(); } while (value >= upperExclusive);
  return value % bound;
}

export function sampleProbes(probes: Probe[], nextUint32: () => number = randomUint32): Probe[] {
  const pool = uniqueProbes(probes);
  if (pool.length < SAMPLE_SIZE) throw new AppError(503, probePoolMessage(pool.length), 'PROBE_POOL_TOO_SMALL');
  // Partial Fisher-Yates draws without replacement and leaves the source untouched.
  for (let index = 0; index < SAMPLE_SIZE; index++) {
    const selected = index + randomIndex(pool.length - index, nextUint32);
    [pool[index], pool[selected]] = [pool[selected], pool[index]];
  }
  return pool.slice(0, SAMPLE_SIZE);
}
