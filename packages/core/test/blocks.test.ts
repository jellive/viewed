import { describe, it, expect } from 'vitest';
import { extractBlocks, blockSigs, metaSig, unmatchedBlocks, hunksWithBlocks } from '../src/blocks';
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

describe('extractBlocks', () => {
  it('splits runs of -/+ lines, drops context and hunk headers, keeps \\ lines inside a run', () => {
    expect(extractBlocks(P)).toEqual([
      ['-b', '+B'],
      ['-e', '+E', '+E2'],
      ['-last', '\\ No newline at end of file', '+last', '\\ No newline at end of file'],
    ]);
  });
  it('a \\ line after context is not a block', () => {
    expect(extractBlocks('@@ -1 +1 @@\n keep\n\\ No newline at end of file')).toEqual([]);
  });
  it('a hunk header ends a run even without context between', () => {
    expect(extractBlocks('@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d')).toEqual([['-a', '+b'], ['-c', '+d']]);
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
  it('one signature per extractBlocks block, in the same order, over [before, ...block, after]', async () => {
    const sigs = await blockSigs('s', P);
    expect(sigs).toHaveLength(extractBlocks(P).length);
    // 경계 규칙이 extractBlocks 와 같아야 hunksWithBlocks 의 번호와 맞는다 — 서명 입력 모양을 그대로 고정한다
    const want = [
      [' a', '-b', '+B', ' c'],
      [' d', '-e', '+E', '+E2', ''],
      [' x', '-last', '\\ No newline at end of file', '+last', '\\ No newline at end of file', ''],
    ];
    expect(sigs).toEqual(await Promise.all(want.map(async (b) => (await hmacHex('s', JSON.stringify(b))).slice(0, 16))));
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

describe('hunksWithBlocks', () => {
  it('keeps only hunks holding a wanted block, numbering blocks like extractBlocks', () => {
    expect(hunksWithBlocks(P, [2])).toBe(P.split('\n').slice(9).join('\n'));
    expect(hunksWithBlocks(P, [1])).toBe(P.split('\n').slice(0, 9).join('\n'));
    expect(hunksWithBlocks(P, [])).toBe('');
    // '\' 줄을 사이에 둔 -last/+last 는 한 블록 — 블록은 3개뿐이라 3번은 없다
    expect(hunksWithBlocks(P, [3])).toBe('');
  });
});
