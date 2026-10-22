import { describe, it, expect } from 'vitest';
import { buildReview, markRecord } from '../src/review';
import { carryBases, selectCarryBases, targetCarry } from '../src/carry';
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
    const files = ['g', 'a', 'b', 'c', 'd', 'e', 'f', 'h', 'i'].map((p) => file(p));   // 목록 순서 = 집계 삽입 순서: P4(g)가 P1(a)보다 먼저
    const review = await reviewWith(files, [
      { path: 'g', base: P4 }, { path: 'a', base: P1 }, { path: 'b', base: P2 }, { path: 'c', base: P2 }, { path: 'd', base: P3 }, { path: 'e', base: P3 },
      { path: 'f', base: P3 }, { path: 'h', base: N }, { path: 'i', base: P1, viewed: false },
    ]);
    // P3:3, P2:2, then P4 and P1 tie at 1 (i is not viewed). P4's file comes first in the list, so only the tie-break puts P1 first
    expect(carryBases(review, N).slice(0, 3)).toEqual([P3, P2, P1]);
  });
  it('ignores records without base', async () => {
    const review = await reviewWith([file('a')], [{ path: 'a' }]);
    expect(carryBases(review, N)).toEqual([]);
  });
});

describe('selectCarryBases', () => {
  it('a non-ancestor base with the most records does not crowd out valid bases', async () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => file(p));
    const review = await reviewWith(files, [
      { path: 'a', base: P4 }, { path: 'b', base: P4 }, { path: 'c', base: P3 }, { path: 'd', base: P3 }, { path: 'e', base: P2 }, { path: 'f', base: P1 },
    ]);
    const bad = new Set([P4, P3, P2]);   // top three by count are not ancestors
    expect(await selectCarryBases(review, N, async (p) => !bad.has(p))).toEqual([P1]);
    expect(await selectCarryBases(review, N, async () => true)).toEqual([P3, P4, P1]);   // at most 3; ties by string
  });
  it('a failing ancestor check skips that base', async () => {
    const review = await reviewWith([file('a'), file('b')], [{ path: 'a', base: P1 }, { path: 'b', base: P2 }]);
    expect(await selectCarryBases(review, N, async (p) => { if (p === P1) throw new Error('x'); return true; })).toEqual([P2]);
  });
  it('checks at most 10 distinct bases', async () => {
    const bases = Array.from({ length: 12 }, (_, i) => String.fromCharCode(97 + i).repeat(40));
    const files = bases.map((_, i) => file('f' + i));
    const review = await reviewWith(files, bases.map((b, i) => ({ path: 'f' + i, base: b })));
    let checked = 0;
    await selectCarryBases(review, N, async () => { checked++; return false; });
    expect(checked).toBe(10);
  });
});

describe('targetCarry', () => {
  it('(b) carried items remember the base and fingerprint they were viewed under; (a) ones do not', async () => {
    const same = file('same.ts', 'x'), fpSame = await fingerprint(same);
    const review = await reviewWith([file('same.ts', 'n'), file('a.ts')], [{ path: 'same.ts', base: P1, fp: fpSame }]);
    const out = await targetCarry(review, N, [{ base: P1, files: [same] }]);
    const byPath = Object.fromEntries(out.map((i) => [i.file.path, i]));
    expect(markRecord(byPath['same.ts'], 'h', true).prev).toEqual({ base: P1, fp: fpSame });
    expect(markRecord(byPath['same.ts'], 'h', true).base).toBe(N);
    expect(markRecord(byPath['a.ts'], 'h', true)).not.toHaveProperty('prev');
    // a plain toggle on the review item never carries prev forward
    expect(markRecord(review.items.find((i) => i.file.path === 'same.ts')!, 'h', true)).not.toHaveProperty('prev');
  });
});

describe('buildReview with prev', () => {
  const f = file('y.ts', 'n');
  async function withRec(extra: Partial<ViewRecord>, mergeBase = P1) {
    const s = { ...snap([f]), mergeBase };
    const it = (await buildReview(s, {}, S)).items[0];
    const r = await buildReview(s, { [it.key]: { ...markRecord(it, 'old', true), fp: 'other', blocks: undefined, base: N, ...extra } }, S);
    return r.items[0].state;
  }
  it('is viewed when back at prev.base with the same fingerprint', async () => {
    expect(await withRec({ prev: { base: P1, fp: await fingerprint(f) } })).toBe('viewed');
  });
  it.each([
    ['another base', async () => ({ prev: { base: P2, fp: await fingerprint(f) } })],
    ['another fingerprint', async () => ({ prev: { base: P1, fp: 'zz' } })],
    ['unchecked', async () => ({ viewed: false, prev: { base: P1, fp: await fingerprint(f) } })],
  ])('is not viewed with %s', async (_, mk) => {
    expect(await withRec(await mk())).not.toBe('viewed');
  });
});

describe('targetCarry (cont.)', () => {
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
  it('(a) a renamed N-side item is not carried when the P-diff touches only its previousPath', async () => {
    const renamed = file('new.ts', 'x', { status: 'renamed', previousPath: 'old.ts' });
    const review = await reviewWith([renamed, file('z.ts')], [{ path: 'new.ts', base: P1 }]);
    const out = await targetCarry(review, N, [{ base: P1, files: [file('old.ts', 'changed')] }]);
    expect(paths(out)).toEqual(['z.ts']);
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
