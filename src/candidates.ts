import ipaddr from 'ipaddr.js';
import snapshot from '../data/cloudflare-cidrs.json' with { type: 'json' };

export type RawCandidate = { ip: string; family: 4 | 6; cidr: string; reachability: 'unknown' };
export type RandomBytes = (length: number) => Uint8Array;

const distribution = { ipv4: 10, ipv6: 10 };

function bytesToBigInt(bytes: number[] | Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function compileRange(cidr: string, family: 4 | 6) {
  const [address, prefix] = ipaddr.parseCIDR(cidr);
  const hostBits = BigInt((family === 4 ? 32 : 128) - prefix);
  const network = (bytesToBigInt(address.toByteArray()) >> hostBits) << hostBits;
  const size = 1n << hostBits;
  return { cidr, family, first: family === 4 ? network + 1n : network, count: family === 4 ? size - 2n : size };
}

const ranges = {
  ipv4: snapshot.ipv4.map(cidr => compileRange(cidr, 4)),
  ipv6: snapshot.ipv6.map(cidr => compileRange(cidr, 6))
};

function randomBelow(bound: bigint, randomBytes: RandomBytes): bigint {
  const bits = (bound - 1n).toString(2).length;
  const length = Math.ceil(bits / 8);
  let value: bigint;
  do {
    const bytes = randomBytes(length);
    bytes[0] &= 0xff >>> (length * 8 - bits);
    value = bytesToBigInt(bytes);
  } while (value >= bound);
  return value;
}

function formatAddress(value: bigint, family: 4 | 6): string {
  const length = family === 4 ? 4 : 16;
  const bytes = Array.from({ length }, (_, index) => Number((value >> BigInt((length - index - 1) * 8)) & 0xffn));
  return ipaddr.fromByteArray(bytes).toString();
}

export function getCandidatePoolInfo() {
  return {
    checkedAt: snapshot.checkedAt,
    sources: { ...snapshot.sources },
    cidrCounts: { ipv4: ranges.ipv4.length, ipv6: ranges.ipv6.length },
    distribution: { ...distribution },
    sampleSize: distribution.ipv4 + distribution.ipv6,
    strategy: 'uniform-cidr-then-address'
  };
}

export function sampleCandidateIps(randomBytes: RandomBytes = length => crypto.getRandomValues(new Uint8Array(length))): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const family of ['ipv4', 'ipv6'] as const) {
    // Each family fills its own quota; duplicates never borrow from the other family.
    const seen = new Set<string>();
    for (let index = 0; index < distribution[family]; index++) {
      const range = ranges[family][Number(randomBelow(BigInt(ranges[family].length), randomBytes))];
      let ip: string;
      do { ip = formatAddress(range.first + randomBelow(range.count, randomBytes), range.family); } while (seen.has(ip));
      seen.add(ip);
      candidates.push({ ip, family: range.family, cidr: range.cidr, reachability: 'unknown' });
    }
  }
  return candidates;
}
