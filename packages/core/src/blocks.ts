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

// 서명용: [앞 문맥, ...블록, 뒤 문맥]. 문맥은 바로 앞·뒤 줄이 문맥 줄(' ')일 때만, 아니면 ''. 경계는 extractBlocks 와 같다
// 같은 -/+ 블록이 다른 위치에 나타난 것과 구분한다. 1줄인 이유: dev 가 2줄 떨어진 곳을 고친 S1 은 계속 맞아야 한다
function anchoredBlocks(patch: string): string[][] {
  const lines = patch.split('\n');
  const out: string[][] = [];
  let cur: string[] | null = null;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k], c = line[0];
    if (c === '-' || c === '+') {
      if (!cur) { const prev = lines[k - 1]; cur = [prev !== undefined && prev[0] === ' ' ? prev : '']; out.push(cur); }
      cur.push(line);
    } else if (c === '\\') {
      if (cur) cur.push(line);
    } else {
      if (cur) cur.push(c === ' ' ? line : '');
      cur = null;
    }
  }
  if (cur) cur.push('');
  return out;
}

// 짧은 줄(+})의 해시가 사전으로 풀리지 않게 기록 키와 같은 비밀로 HMAC 한다
export function blockSigs(secret: string, patch: string): Promise<string[]> {
  return Promise.all(anchoredBlocks(patch).map(async (b) => (await hmacHex(secret, JSON.stringify(b))).slice(0, 16)));
}

// 내용 밖의 축 — 상태·이전 경로·mode 가 바뀌면 블록이 같아도 확인함으로 두지 않는다
export async function metaSig(file: ChangedFile): Promise<string> {
  return (await sha256Hex(JSON.stringify([file.status, file.previousPath ?? '', file.mode ?? '']))).slice(0, 16);
}

const MAX_CELLS = 1_000_000;

// cur 중 prev 와 순서를 지켜 맞출 수 없는 블록 번호(최장 공통 부분열 밖). 가운데 표가 너무 크면 가운데를 전부 안 맞음으로 본다
export function unmatchedBlocks(prev: string[], cur: string[]): number[] {
  // 앞뒤로 같은 블록은 맞은 것 — 가운데만 표로 계산한다(블록 많은 파일에서 같은 배열이 상한에 걸려 전부 안 맞음이 되지 않게)
  let s = 0;
  while (s < prev.length && s < cur.length && prev[s] === cur[s]) s++;
  let e = 0;
  while (e < prev.length - s && e < cur.length - s && prev[prev.length - 1 - e] === cur[cur.length - 1 - e]) e++;
  const p = prev.slice(s, prev.length - e), c = cur.slice(s, cur.length - e);
  const n = p.length, m = c.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return c.map((_, j) => s + j);
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = p[i] === c[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: number[] = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && p[i] === c[j]) { i++; j++; }
    else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++;
    else { out.push(s + j); j++; }
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
