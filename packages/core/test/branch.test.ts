import { describe, it, expect } from 'vitest';
import { buildReview, markRecord, movedBases } from '../src/review';
import { branchMatches, carryBases } from '../src/carry';
import type { ChangedFile, DeviceState, Snapshot } from '../src/types';

// 브랜치 이름이 바뀌어도(feat → feat2) 다른 브랜치에서 확인한 같은 경로의 기록을 찾는다
const S = 'secret';
const MB = 'm'.repeat(40), OLD_MB = 'o'.repeat(40);
const FEAT = 'refs/heads/feat', FEAT2 = 'refs/heads/feat2', OTHER = 'refs/heads/other';
const snap = (branch: string, files: ChangedFile[], mergeBase = MB): Snapshot =>
  ({ owner: 'local', repo: 'github.com/x/y', base: 'refs/heads/main', branch, headSha: 'h'.repeat(40), files, truncated: false, mergeBase });
// 덩어리 하나 = 블록 하나. 블록마다 다른 문맥이라 서명이 겹치지 않는다
const hunk = (at: number, from: string, to: string) => `@@ -${at},3 +${at},3 @@\n c${at}\n-${from}\n+${to}\n c${at + 2}`;
const file = (path: string, hunks: string[], blob = 'b-' + hunks.join('|')): ChangedFile =>
  ({ path, status: 'modified', blobSha: blob, patch: hunks.join('\n'), mode: '100644' });
const X = hunk(1, 'a', 'A'), Y = hunk(10, 'b', 'B'), Z = hunk(20, 'c', 'C');

// branch 에서 files 를 확인한 기록
async function viewedOn(branch: string, files: ChangedFile[], at: string, mergeBase = MB, state: DeviceState = {}): Promise<DeviceState> {
  const r = await buildReview(snap(branch, files, mergeBase), {}, S);
  for (const it of r.items) state[it.key] = markRecord(it, 'a'.repeat(40), true, new Date(at));
  return state;
}
const open = async (files: ChangedFile[], state: DeviceState, branches: string[], mergeBase = MB) => {
  const s = snap(FEAT2, files, mergeBase);
  const first = await buildReview(s, state, S);
  return { s, first, m: await branchMatches(first, s, state, S, branches) };
};

describe('branchMatches', () => {
  it('a file whose diff is exactly the one viewed on another branch is an exact match', async () => {
    const state = await viewedOn(FEAT, [file('a.ts', [X])], '2026-10-01T00:00:00Z');
    const { m } = await open([file('a.ts', [X])], state, [FEAT]);
    expect(m.exact.map((i) => i.file.path)).toEqual(['a.ts']);
    expect(m.near.size).toBe(0);
  });

  it('the exact match is written as the new branch\'s own record — viewed, with this merge base', async () => {
    const state = await viewedOn(FEAT, [file('a.ts', [X])], '2026-10-01T00:00:00Z', OLD_MB);
    const { s, m } = await open([file('a.ts', [X])], state, [FEAT]);
    for (const it of m.exact) state[it.key] = markRecord(it, s.headSha, true);
    const r = await buildReview(s, state, S);
    expect(r.items[0].state).toBe('viewed');
    expect(r.items[0].record?.base).toBe(MB);
    // 옛 대상 이어받기 후보에 옛 브랜치의 base 가 안 들어간다
    expect(carryBases(r, MB)).toEqual([]);
  });

  it('a file sharing some changes with one viewed elsewhere is a near match carrying that record\'s blocks', async () => {
    const state = await viewedOn(FEAT, [file('b.ts', [X])], '2026-10-01T00:00:00Z');
    const { m } = await open([file('b.ts', [X, Y])], state, [FEAT]);
    expect(m.exact).toEqual([]);
    expect([...m.near.keys()]).toEqual(['b.ts']);
  });

  it('no shared change, a record of the open branch (even unchecked), others\' files and the open branch itself are skipped', async () => {
    const state = await viewedOn(FEAT, [file('c.ts', [Z]), file('d.ts', [X]), file('e.ts', [X])], '2026-10-01T00:00:00Z');
    // d.ts 는 지금 브랜치에서 확인을 풀었다
    const mine = await buildReview(snap(FEAT2, [file('d.ts', [X])]), {}, S);
    state[mine.items[0].key] = markRecord(mine.items[0], 'h'.repeat(40), false);
    const s = snap(FEAT2, [file('c.ts', [X]), file('d.ts', [X]), file('e.ts', [X])]);
    const first = await buildReview(s, state, S, new Map([['e.ts', ['bob']]]));
    const m = await branchMatches(first, s, state, S, [FEAT, FEAT2, FEAT]);
    expect(m.exact).toEqual([]);
    expect(m.near.size).toBe(0);
  });

  it('a file without a patch matches exactly only when the base is the same — the blob alone does not say what changed', async () => {
    const bin = (blob: string): ChangedFile => ({ path: 'p.png', status: 'modified', blobSha: blob, mode: '100644' });
    const state = await viewedOn(FEAT, [bin('z'.repeat(40))], '2026-10-01T00:00:00Z', OLD_MB);
    expect((await open([bin('z'.repeat(40))], state, [FEAT])).m.exact).toEqual([]);
    expect((await open([bin('z'.repeat(40))], state, [FEAT], OLD_MB)).m.exact.map((i) => i.file.path)).toEqual(['p.png']);
  });

  it('a newer uncheck on another branch beats an older check — the latest decision on that file wins', async () => {
    let state = await viewedOn(FEAT, [file('a.ts', [X]), file('b.ts', [X])], '2026-10-01T00:00:00Z');
    const later = await buildReview(snap(OTHER, [file('a.ts', [X]), file('b.ts', [X, Z])]), {}, S);
    for (const it of later.items) state[it.key] = markRecord(it, 'a'.repeat(40), false, new Date('2026-10-05T00:00:00Z'));
    const { m } = await open([file('a.ts', [X]), file('b.ts', [X, Y])], state, [FEAT, OTHER]);
    expect(m.exact).toEqual([]);   // a.ts: 같은 diff 를 OTHER 에서 나중에 풀었다
    expect(m.near.size).toBe(0);   // b.ts: 겹치는 기록 중 최신이 푼 것
  });

  it('an exact match wins over a newer near match, and among near matches the newest record wins', async () => {
    let state = await viewedOn(FEAT, [file('a.ts', [X, Y])], '2026-10-01T00:00:00Z');
    state = await viewedOn(OTHER, [file('a.ts', [X])], '2026-10-05T00:00:00Z', MB, state);
    const ex = await open([file('a.ts', [X, Y])], state, [OTHER, FEAT]);
    expect(ex.m.exact.map((i) => i.file.path)).toEqual(['a.ts']);

    let st2 = await viewedOn(FEAT, [file('b.ts', [X])], '2026-10-01T00:00:00Z');
    st2 = await viewedOn(OTHER, [file('b.ts', [X, Y])], '2026-10-05T00:00:00Z', MB, st2);
    const { s, m } = await open([file('b.ts', [X, Y, Z])], st2, [FEAT, OTHER]);
    const r = await buildReview(s, st2, S, undefined, undefined, m.near);
    // 최신(OTHER) 기록은 X·Y 를 봤다 — Z 만 새 블록
    expect(r.items[0].newBlocks).toEqual([2]);
  });
});

describe('buildReview with matches from another branch', () => {
  it('shows only the blocks not seen elsewhere, without a record, so nothing else builds on it', async () => {
    const state = await viewedOn(FEAT, [file('b.ts', [X])], '2026-10-01T00:00:00Z', OLD_MB);
    const { s, m } = await open([file('b.ts', [X, Y])], state, [FEAT]);
    const r = await buildReview(s, state, S, undefined, undefined, m.near);
    expect(r.items[0]).toMatchObject({ state: 'changed-since-viewed', newBlocks: [1], elsewhere: true });
    expect(r.items[0].record).toBeUndefined();
    expect(r.viewedCount).toBe(0);
    expect(movedBases(r)).toEqual([]);
    expect(carryBases(r, MB)).toEqual([]);
  });

  it('every block seen elsewhere with a different diff is not viewed — no new block, so all of it is shown dimmed', async () => {
    const state = await viewedOn(FEAT, [file('b.ts', [X, Y])], '2026-10-01T00:00:00Z');
    const { s, m } = await open([file('b.ts', [X])], state, [FEAT]);
    expect([...m.near.keys()]).toEqual(['b.ts']);
    const r = await buildReview(s, state, S, undefined, undefined, m.near);
    // 서명에 위치가 없어 같은 변경이 파일의 다른 곳에 있을 수 있다 — 확인함으로 치지 않는다
    expect(r.items[0]).toMatchObject({ state: 'changed-since-viewed', newBlocks: [], elsewhere: true });
    expect(r.viewedCount).toBe(0);
  });

  it('a record of the open branch wins over a match from elsewhere', async () => {
    const state = await viewedOn(FEAT, [file('b.ts', [X])], '2026-10-01T00:00:00Z');
    const { s, m } = await open([file('b.ts', [X, Y])], state, [FEAT]);
    const mine = await buildReview(s, {}, S);
    state[mine.items[0].key] = markRecord(mine.items[0], s.headSha, false);
    const r = await buildReview(s, state, S, undefined, undefined, m.near);
    expect(r.items[0].state).toBe('unread');
    expect(r.items[0].newBlocks).toBeUndefined();
  });
});
