import { sha256Hex } from './fingerprint';
import { hmacHex } from './keys';
import type { ChangedFile } from './types';

// 블록 = 덩어리 안에서 연속한 -/+ 줄. 문맥 줄과 덩어리 머리는 안 든다 — 문맥은 base 쪽 변경으로도 바뀐다(spec §3)
// '\ No newline' 줄은 바로 앞이 -/+ 면 그 블록에 붙인다(끝 개행 변경도 내 변경)
export function extractBlocks(patch: string): string[][] {
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of patch.split('\n')) {
    const c = line[0];
    if (c === '-' || c === '+') {
      if (!cur) { cur = []; blocks.push(cur); }
      cur.push(line);
    } else if (c === '\\') {
      if (cur) cur.push(line);
    } else cur = null;
  }
  return blocks;
}

// 짧은 줄(+})의 해시가 사전으로 풀리지 않게 기록 키와 같은 비밀로 HMAC 한다
export function blockSigs(secret: string, patch: string): Promise<string[]> {
  return Promise.all(extractBlocks(patch).map(async (b) => (await hmacHex(secret, JSON.stringify(b))).slice(0, 16)));
}

// 내용 밖의 축 — 상태·이전 경로·mode 가 바뀌면 블록이 같아도 확인함으로 두지 않는다
export async function metaSig(file: ChangedFile): Promise<string> {
  return (await sha256Hex(JSON.stringify([file.status, file.previousPath ?? '', file.mode ?? '']))).slice(0, 16);
}

const MAX_CELLS = 1_000_000;

// cur 중 prev 와 순서를 지켜 맞출 수 없는 블록 번호(최장 공통 부분열 밖). 표가 너무 크면 전부 안 맞음으로 본다
export function unmatchedBlocks(prev: string[], cur: string[]): number[] {
  const n = prev.length, m = cur.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return cur.map((_, j) => j);
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = prev[i] === cur[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: number[] = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && prev[i] === cur[j]) { i++; j++; }
    else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++;
    else { out.push(j); j++; }
  }
  return out;
}

// want 번 블록이 든 덩어리만 남긴다. 블록 번호는 extractBlocks 와 같은 규칙으로 센다
export function hunksWithBlocks(patch: string, want: number[]): string {
  const keep = new Set(want);
  const out: string[] = [];
  let hunk: string[] = [], hit = false, b = -1, inBlock = false;
  const flush = () => { if (hit) out.push(...hunk); hunk = []; hit = false; };
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) { flush(); hunk.push(line); inBlock = false; continue; }
    const c = line[0];
    if (c === '-' || c === '+') {
      if (!inBlock) { b++; inBlock = true; }
      if (keep.has(b)) hit = true;
    } else if (c !== '\\') inBlock = false;
    hunk.push(line);
  }
  flush();
  return out.join('\n');
}
