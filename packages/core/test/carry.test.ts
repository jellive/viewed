import { describe, it, expect } from 'vitest';
import { buildReview, markRecord } from '../src/review';
import { carryBases, targetCarry } from '../src/carry';
import { fingerprint } from '../src/fingerprint';
import type { ChangedFile, DeviceState, Review, Snapshot, ViewRecord } from '../src/types';

const S = 'secret';
const N = 'n'.repeat(40), P1 = 'p1'.padEnd(40, '0'), P2 = 'p2'.padEnd(40, '0'), P3 = 'p3'.padEnd(40, '0'), P4 = 'p4'.padEnd(40, '0');
const file = (path: string, body = 'x', extra: Partial<ChangedFile> = {}): ChangedFile =>
  ({ path, status: 'modified', blobSha: 'b-' + body, patch: `@@ -1 +1 @@\n-a\n+${body}`, mode: '100644', ...extra });
const snap = (files: ChangedFile[]): Snapshot =>
  ({ owner: 'local', repo: 'r', base: 'refs/heads/dev', branch: 'refs/heads/feat', headSha: 'h'.repeat(40), files, truncated: false, mergeBase: N });

interface Rec { path: string; base?: string; viewed?: boolean; fp?: string }
// 기록을 가진 리뷰를 만든다: 먼저 키를 얻고, 같은 키에 기록을 넣어 다시 만든다
async function reviewWith(files: ChangedFile[], recs: Rec[], others?: Map<string, string[]>): Promise<Review> {
  const keys = new Map((await buildReview(snap(files), {}, S)).items.map((i) => [i.file.path, i]));
  const state: DeviceState = {};
  for (const r of recs) {
    const it = keys.get(r.path)!;
    const rec: ViewRecord = { ...markRecord(it, 'old', r.viewed ?? true), ...(r.base ? { base: r.base } : {}), fp: r.fp ?? 'old-fp', blocks: undefined };   // 블록 이어받기(기존)가 먼저 칠하지 않게
    state[it.key] = rec;
  }
  return buildReview(snap(files), state, S, others);
}
const paths = (items: { file: ChangedFile }[]) => items.map((i) => i.file.path).sort();

describe('carryBases', () => {
  it('picks viewed records whose base differs, most first, at most 3', async () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((p) => file(p));
    const review = await reviewWith(files, [
      { path: 'a', base: P1 }, { path: 'b', base: P2 }, { path: 'c', base: P2 }, { path: 'd', base: P3 }, { path: 'e', base: P3 },
      { path: 'f', base: P3 }, { path: 'g', base: P4 }, { path: 'h', base: N }, { path: 'i', base: P1, viewed: false },
    ]);
    // P3:3, P2:2, then P1 and P4 tie at... P1 has 1 viewed (i is not viewed), P4 has 1 -> string ascending
    expect(carryBases(review, N)).toEqual([P3, P2, P1]);
  });
  it('ignores records without base', async () => {
    const review = await reviewWith([file('a')], [{ path: 'a' }]);
    expect(carryBases(review, N)).toEqual([]);
  });
});

describe('targetCarry', () => {
  it('(a) a file absent from the P-diff is carried', async () => {
    const review = await reviewWith([file('a'), file('b')], [{ path: 'a', base: P1 }]);
    const out = await targetCarry(review, N, [{ base: P1, files: [file('b')] }]);
    expect(paths(out)).toEqual(['a']);
  });
  it('(a) a path that is a rename source in the P-diff is not carried', async () => {
    const review = await reviewWith([file('old.ts'), file('z.ts')], [{ path: 'old.ts', base: P1 }]);
    const pd = [file('new.ts', 'x', { status: 'renamed', previousPath: 'old.ts' })];
    expect(paths(await targetCarry(review, N, [{ base: P1, files: pd }]))).toEqual(['z.ts']);   // old.ts 는 빠지고 P-diff 에 없는 z.ts 만
  });
  it('(a) also carries files nobody recorded, when absent from the P-diff', async () => {
    const review = await reviewWith([file('a'), file('b')], [{ path: 'b', base: P1 }]);
    const out = await targetCarry(review, N, [{ base: P1, files: [] }]);
    expect(paths(out)).toEqual(['a', 'b']);
  });
  it('(b) a P-viewed file whose P-diff fingerprint matches is carried; a changed one is not', async () => {
    const same = file('same.ts', 'x'), moved = file('moved.ts', 'y');
    const review = await reviewWith([file('same.ts', 'n'), file('moved.ts', 'n')], [
      { path: 'same.ts', base: P1, fp: await fingerprint(same) }, { path: 'moved.ts', base: P1, fp: 'stale-fp' },
    ]);
    const out = await targetCarry(review, N, [{ base: P1, files: [same, moved] }]);
    expect(paths(out)).toEqual(['same.ts']);
  });
  it('viewed:false, base===N, already viewed, and others files are never carried', async () => {
    const files = [file('unviewed'), file('atN'), file('done'), file('theirs')];
    const review = await reviewWith(files, [
      { path: 'unviewed', base: P1, viewed: false }, { path: 'atN', base: N }, { path: 'done', base: P1, fp: await fingerprint(files[2]) },
    ], new Map([['theirs', ['Bob']]]));
    // all absent from the P-diff, so only the exclusion rules stop them
    const out = await targetCarry(review, N, [{ base: P1, files: [] }]);
    expect(paths(out)).toEqual([]);
  });
  it('with two P, a file qualifies through either', async () => {
    const a = file('a', 'x'), c = file('c', 'x');
    const review = await reviewWith([file('a', 'n'), file('b'), file('c')], [
      { path: 'a', base: P2, fp: await fingerprint(a) }, { path: 'b', base: P1 }, { path: 'c', base: P1, fp: 'stale' }]);
    const p1 = { base: P1, files: [file('a', 'other'), file('b', 'changed'), file('c', 'changed')] };
    const p2 = { base: P2, files: [a, file('c', 'changed')] };
    expect(paths(await targetCarry(review, N, [p1]))).toEqual([]);
    // a: (b) through P2 / b: absent from the P2-diff / c: in both diffs and its record matches neither
    expect(paths(await targetCarry(review, N, [p1, p2]))).toEqual(['a', 'b']);
  });
});
