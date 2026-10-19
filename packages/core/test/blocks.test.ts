import { describe, it, expect } from 'vitest';
import { blockSigs, metaSig, unmatchedBlocks, markedHunks } from '../src/blocks';
import { hmacHex, recordKey } from '../src/keys';

const P = [
  '@@ -1,7 +1,7 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  ' d',
  '-e',
  '+E',
  '+E2',
  '@@ -20,3 +21,3 @@',
  ' x',
  '-last',
  '\\ No newline at end of file',
  '+last',
  '\\ No newline at end of file',
].join('\n');

// 서명(blockSigs)과 덩어리 선별(markedHunks)은 블록을 따로 센다 — 번호가 어긋나면 엉뚱한 덩어리가 보인다
// markedHunks 가 센 블록 수 = 비지 않은 덩어리를 돌려주는 가장 큰 번호 + 1
const markedCount = (patch: string) => { let i = 0; while (markedHunks(patch, [i]).patch !== '') i++; return i; };
const sigInput = (b: string[]) => hmacHex('s', JSON.stringify(b)).then((h) => h.slice(0, 16));

describe('block boundaries — signatures and markedHunks count the same blocks', () => {
  it('-/+ runs are blocks; context and hunk headers split them, \\ lines inside a run stay in it', async () => {
    expect(await blockSigs('s', P)).toHaveLength(3);
    expect(markedCount(P)).toBe(3);
  });
  it('a \\ line after context is not a block', async () => {
    const p = '@@ -1 +1 @@\n keep\n\\ No newline at end of file';
    expect(await blockSigs('s', p)).toEqual([]);
    expect(markedCount(p)).toBe(0);
  });
  it('a hunk header ends a run even without context between', async () => {
    const p = '@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d';
    expect(await blockSigs('s', p)).toEqual(await Promise.all([['', '-a', '+b', ''], ['', '-c', '+d', '']].map(sigInput)));
    expect(markedCount(p)).toBe(2);
    expect(markedHunks(p, [1]).patch).toBe('@@ -9 +9 @@\n-c\n+d');
  });
  it('a blank line ends a run like a context line, but is no neighbor', async () => {
    const p = '@@ -1,3 +1,3 @@\n-a\n+A\n\n-b\n+B';
    expect(await blockSigs('s', p)).toEqual(await Promise.all([['', '-a', '+A', ''], ['', '-b', '+B', '']].map(sigInput)));
    expect(markedCount(p)).toBe(2);
    expect(markedHunks(p, [1])).toEqual({ patch: p, seen: [1, 2] });
  });
  it('a trailing newline adds no block', async () => {
    expect(await blockSigs('s', '@@ -1 +1 @@\n-x\n+y\n')).toHaveLength(1);
    expect(markedCount('@@ -1 +1 @@\n-x\n+y\n')).toBe(1);
  });
});

describe('blockSigs / metaSig', () => {
  it('16 hex per block, deterministic, secret-dependent, no line normalization', async () => {
    const a = await blockSigs('s', P);
    expect(a).toHaveLength(3);
    for (const s of a) expect(s).toMatch(/^[0-9a-f]{16}$/);
    expect(await blockSigs('s', P)).toEqual(a);
    expect(await blockSigs('other', P)).not.toEqual(a);
    expect((await blockSigs('s', '@@ -1 +1 @@\n-x\n+y\r'))[0]).not.toBe((await blockSigs('s', '@@ -1 +1 @@\n-x\n+y'))[0]);
  });
  it('the same block with the same neighbors gets the same signature at any hunk position', async () => {
    const at1 = await blockSigs('s', '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
    expect(await blockSigs('s', '@@ -40,3 +40,3 @@\n a\n-b\n+B\n c')).toEqual(at1);
  });
  it('a different line before the block gives a different signature', async () => {
    const a = await blockSigs('s', '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
    expect((await blockSigs('s', '@@ -1,3 +1,3 @@\n z\n-b\n+B\n c'))[0]).not.toBe(a[0]);
  });
  it('a block at the start of a hunk differs from the same block after context', async () => {
    const a = await blockSigs('s', '@@ -1,2 +1,2 @@\n-b\n+B\n c');
    expect((await blockSigs('s', '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c'))[0]).not.toBe(a[0]);
  });
  it('one signature per block, in patch order, over [before, ...block, after]', async () => {
    const sigs = await blockSigs('s', P);
    // 블록 경계와 앞뒤 문맥을 서명 입력 모양으로 그대로 고정한다 — '\\' 줄은 블록 안, 덩어리 끝의 뒤 문맥은 ''
    const want = [
      [' a', '-b', '+B', ' c'],
      [' d', '-e', '+E', '+E2', ''],
      [' x', '-last', '\\ No newline at end of file', '+last', '\\ No newline at end of file', ''],
    ];
    expect(sigs).toEqual(await Promise.all(want.map(sigInput)));
  });
  it('meta changes with status, previous path and mode', async () => {
    const base = { path: 'a', status: 'modified' as const, blobSha: 'x' };
    const m = await metaSig({ ...base, mode: '100644' });
    expect(m).toMatch(/^[0-9a-f]{16}$/);
    expect(await metaSig({ ...base, mode: '100755' })).not.toBe(m);
    expect(await metaSig({ ...base, mode: '100644', status: 'renamed', previousPath: 'b' })).not.toBe(m);
  });
});

describe('recordKey still the same after the hmac refactor', () => {
  it('known value', async () => {
    // 리팩터 전 알고리즘(HMAC-SHA256, JSON [owner,repo,branch,path] 소문자 owner/repo)으로 미리 계산한 값 — 기존 기록이 그대로 찾아져야 한다
    expect(await recordKey('shared-secret', 'acme', 'widget', 'feat', 'a.ts')).toBe('c3a8cc5562cace5d8f8c33c17d7ea8c0a3f8ef8a36d3cf286fd87f9042bc0c32');
  });
});

describe('unmatchedBlocks', () => {
  it('nothing new when cur equals prev, or is an ordered subset of it', () => {
    expect(unmatchedBlocks(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(unmatchedBlocks(['a', 'b'], ['b'])).toEqual([]);
    expect(unmatchedBlocks(['a', 'b'], [])).toEqual([]);
  });
  it('a new block is unmatched', () => {
    expect(unmatchedBlocks(['a'], ['a', 'c'])).toEqual([1]);
    expect(unmatchedBlocks([], ['a'])).toEqual([0]);
  });
  it('a new block before a viewed one: only the new one is unmatched', () => {
    // 앞에서부터 prev 를 버리기만 하면 뒤의 확인한 블록까지 새 블록으로 잡힌다 — 최장 공통 부분열 표를 실제로 쓰는지
    expect(unmatchedBlocks(['x'], ['a', 'x'])).toEqual([0]);
  });
  it('the same block added a second time: the extra copy is unmatched', () => {
    expect(unmatchedBlocks(['a'], ['a', 'a'])).toEqual([1]);
  });
  it('swapped order: one of the two is unmatched', () => {
    expect(unmatchedBlocks(['a', 'b'], ['b', 'a'])).toHaveLength(1);
  });
  it('a long identical list matches fully — the cap only applies to the differing middle', () => {
    const big = Array.from({ length: 1001 }, (_, i) => `s${i}`);
    expect(unmatchedBlocks(big, big)).toEqual([]);
  });
  it('a middle over the size cap is all unmatched (conservative), shared ends stay matched', () => {
    const mid = (p: string) => Array.from({ length: 1000 }, (_, i) => `${p}${i}`);
    expect(unmatchedBlocks(['x', ...mid('p'), 'y'], ['x', ...mid('c'), 'y'])).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
  });
  it('one block inserted between shared ends: only it is unmatched, numbered in cur', () => {
    expect(unmatchedBlocks(['a', 'b', 'c'], ['a', 'x', 'b', 'c'])).toEqual([1]);
  });
});

describe('markedHunks', () => {
  it('keeps only hunks holding a wanted block', () => {
    expect(markedHunks(P, [2]).patch).toBe(P.split('\n').slice(9).join('\n'));
    expect(markedHunks(P, [1]).patch).toBe(P.split('\n').slice(0, 9).join('\n'));
    expect(markedHunks(P, []).patch).toBe('');
    // '\' 줄을 사이에 둔 -last/+last 는 한 블록 — 블록은 3개뿐이라 3번은 없다
    expect(markedHunks(P, [3]).patch).toBe('');
  });
  it('also returns the line numbers of blocks not asked for', () => {
    // want=[1] 은 첫 덩어리를 남긴다 — 같은 덩어리의 블록 0(-b/+B)은 이미 확인한 것
    expect(markedHunks(P, [1])).toEqual({ patch: P.split('\n').slice(0, 9).join('\n'), seen: [2, 3] });
    expect(markedHunks(P, [0]).seen).toEqual([6, 7, 8]);
    expect(markedHunks(P, [0, 1]).seen).toEqual([]);
    expect(markedHunks(P, [])).toEqual({ patch: '', seen: [] });
  });
  it('numbers lines in the returned patch, not the input', () => {
    // 둘째 덩어리만 남는다 — 번호가 입력 기준이면 6·7 이 나온다
    const Q = ['@@ -1,2 +1,2 @@', '-q', '+Q', ' r', '@@ -10,5 +10,5 @@', ' s', '-t', '+T', ' u', '-v', '+V'].join('\n');
    expect(markedHunks(Q, [2])).toEqual({ patch: Q.split('\n').slice(4).join('\n'), seen: [2, 3] });
    // 둘 다 남으면 둘째 덩어리의 번호는 앞 덩어리 길이만큼 밀린다
    expect(markedHunks(Q, [0, 2])).toEqual({ patch: Q, seen: [6, 7] });
  });
  it('a \\ line inside a seen block is seen too', () => {
    const R = ['@@ -1,3 +1,3 @@', '-a', '+A', ' mid', '-last', '\\ No newline at end of file', '+last2', '\\ No newline at end of file'].join('\n');
    expect(markedHunks(R, [0]).seen).toEqual([4, 5, 6, 7]);
    expect(markedHunks(R, [1]).seen).toEqual([1, 2]);
  });
});
