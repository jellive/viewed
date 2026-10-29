import { describe, it, expect } from 'vitest';
import { buildReview, markRecord } from '../src/review';
import { recordKey } from '../src/keys';
import { loadSnapshot } from '../src/snapshot';
import { GitHub, type FetchLike } from '../src/github';
import type { Snapshot, DeviceState } from '../src/types';

const S = 'shared-secret';
const snap = (files: Snapshot['files'], truncated = false): Snapshot =>
  ({ owner: 'acme', repo: 'widget', base: 'main', branch: 'feat', headSha: 'h2', files, truncated });
const fa = { path: 'a.ts', status: 'modified' as const, blobSha: 'a1', patch: 'pa' };
const fb = { path: 'b.ts', status: 'modified' as const, blobSha: 'b1', patch: 'pb' };

describe('recordKey', () => {
  it('is hex HMAC and does not contain the names', async () => {
    const k = await recordKey(S, 'acme', 'widget', 'feat', 'a.ts');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(await recordKey('other', 'acme', 'widget', 'feat', 'a.ts')).not.toBe(k);
  });
  it('does not collide when a separator char moves between branch and path', async () => {
    expect(await recordKey(S, 'acme', 'widget', 'feat|a', 'b.ts'))
      .not.toBe(await recordKey(S, 'acme', 'widget', 'feat', 'a|b.ts'));
  });
});

describe('buildReview', () => {
  it('everything unread with no records', async () => {
    const r = await buildReview(snap([fa, fb]), {}, S);
    expect(r.items.map((i) => i.state)).toEqual(['unread', 'unread']);
    expect(r).toMatchObject({ viewedCount: 0, total: 2, complete: false, incomplete: false });
  });

  it('viewed when the fingerprint matches; complete when all viewed', async () => {
    const first = await buildReview(snap([fa, fb]), {}, S);
    const state: DeviceState = {};
    for (const it of first.items) state[it.key] = markRecord(it, 'h1', true, new Date('2026-10-15T00:00:00Z'));
    const r = await buildReview(snap([fa, fb]), state, S);
    expect(r.items.every((i) => i.state === 'viewed')).toBe(true);
    expect(r.complete).toBe(true);
  });

  it('only the changed file becomes changed-since-viewed', async () => {
    const first = await buildReview(snap([fa, fb]), {}, S);
    const state: DeviceState = {};
    for (const it of first.items) state[it.key] = markRecord(it, 'h1', true);
    // merge base 없는 스냅샷이라 블록 판정 없이 지문 변화가 곧 확인 후 바뀜이다
    const r = await buildReview(snap([{ ...fa, patch: '@@ -1 +1 @@\n-a\n+pa2', blobSha: 'a2' }, fb]), state, S);
    expect(r.items.map((i) => i.state)).toEqual(['changed-since-viewed', 'viewed']);
    expect(r.items[0].record?.blob).toBe('a1');
    expect(r.viewedCount).toBe(1);
    expect(r.complete).toBe(false);
  });

  it('an unchecked record (viewed:false) is unread', async () => {
    const first = await buildReview(snap([fa]), {}, S);
    const state = { [first.items[0].key]: markRecord(first.items[0], 'h1', false) };
    expect((await buildReview(snap([fa]), state, S)).items[0].state).toBe('unread');
  });

  it('never complete when the list is truncated', async () => {
    const first = await buildReview(snap([fa], true), {}, S);
    const state = { [first.items[0].key]: markRecord(first.items[0], 'h1', true) };
    const r = await buildReview(snap([fa], true), state, S);
    expect(r.viewedCount).toBe(1);
    expect(r).toMatchObject({ incomplete: true, complete: false });
  });

  it('an empty diff is not complete', async () => {
    expect((await buildReview(snap([]), {}, S)).complete).toBe(false);
  });
});

describe('loadSnapshot', () => {
  it('pins the head sha, fills modes, uses the default branch as base', async () => {
    const routes: Record<string, unknown> = {
      '/repos/acme/widget': { default_branch: 'main' },
      '/repos/acme/widget/branches/feat': { commit: { sha: 'h9' } },
      '/compare/main...h9': { files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: 'p' }], merge_base_commit: { sha: 'mb9' } },
      '/git/trees/h9?recursive=1': { truncated: false, tree: [{ path: 'a.ts', mode: '100755', type: 'blob' }] },
    };
    const f: FetchLike = async (url) => {
      const k = Object.keys(routes).find((p) => url.endsWith(p));
      return k ? new Response(JSON.stringify(routes[k])) : new Response('', { status: 404 });
    };
    const s = await loadSnapshot(new GitHub('t', f), 'acme', 'widget', 'feat');
    expect(s).toMatchObject({ base: 'main', headSha: 'h9', truncated: false });
    expect(s.files[0].mode).toBe('100755');
    expect(s.mergeBase).toBe('mb9');
  });
});

describe('buildReview — block judgment after a rebase or merge (spec §5)', () => {
  const ctx = (lines: string[]) => lines.join('\n');
  // S1: dev 가 내 줄 근처(line 6)를 고쳐 문맥만 바뀜
  const p1 = ctx(['@@ -5,7 +5,7 @@', ' line 5', ' line 6', ' line 7', '-line 8', '+line 8 FEAT', ' line 9', ' line 10', ' line 11']);
  const p1rebased = ctx(['@@ -5,7 +5,7 @@', ' line 5', ' line 6 DEV', ' line 7', '-line 8', '+line 8 FEAT', ' line 9', ' line 10', ' line 11']);
  // S3: 머지 뒤 내 새 블록(line 11)
  const p3 = ctx(['@@ -5,8 +5,8 @@', ' line 6 DEV', ' line 7', '-line 8', '+line 8 FEAT', ' line 9', ' line 10', '-line 11', '+line 11 FEAT2', ' line 12']);
  const at = new Date('2026-10-15T00:00:00Z');
  const snapAt = (patch: string | undefined, mergeBase: string, extra: Partial<Snapshot['files'][number]> = {}) =>
    ({ ...snap([{ path: 'a.ts', status: 'modified' as const, blobSha: patch ?? 'bin', ...(patch !== undefined ? { patch } : {}), mode: '100644', ...extra }]), mergeBase });
  async function viewedAt(s: Snapshot) {
    const r = await buildReview(s, {}, S);
    return { [r.items[0].key]: markRecord(r.items[0], 'h1', true, at) };
  }

  it('markRecord stores blocks, base and meta', async () => {
    const st = await viewedAt(snapAt(p1, 'mb1'));
    const rec = Object.values(st)[0];
    expect(rec.blocks).toHaveLength(1);
    expect(rec.base).toBe('mb1');
    expect(rec.meta).toMatch(/^[0-9a-f]{16}$/);
  });

  it('S1 context-only change stays viewed and is marked carried', async () => {
    const st = await viewedAt(snapAt(p1, 'mb1'));
    const it = (await buildReview(snapAt(p1rebased, 'mb2'), st, S)).items[0];
    expect(it.state).toBe('viewed');
    expect(it.carried).toBe('same');
    expect(it.dropped).toBeUndefined();
  });

  const two = ctx(['@@ -1,3 +1,3 @@', ' l1', '-l2', '+l2 A', ' l3', '@@ -9,3 +9,3 @@', ' l9', '-l10', '+l10 B', ' l11']);
  const one = ctx(['@@ -9,3 +9,3 @@', ' l9', '-l10', '+l10 B', ' l11']);

  it('S2 my blocks shrank to a subset after the base moved: viewed, marked shrunk with the dropped count', async () => {
    const st = await viewedAt(snapAt(two, 'mb1'));
    const it = (await buildReview(snapAt(one, 'mb2'), st, S)).items[0];
    expect(it.state).toBe('viewed');
    expect(it.carried).toBe('shrunk');
    expect(it.dropped).toBe(1);
  });

  it('base unchanged and one of my blocks removed: changed-since-viewed (no block judgment)', async () => {
    // base 가 그대로면 블록이 사라진 것도 내 변경이다 — 확인함으로 숨기지 않는다
    const st = await viewedAt(snapAt(two, 'mb1'));
    const it = (await buildReview(snapAt(one, 'mb1'), st, S)).items[0];
    expect(it.state).toBe('changed-since-viewed');
    expect(it.newBlocks).toBeUndefined();
    expect(it.carried).toBeUndefined();
  });

  it('base moved and the same -/+ block now sits between different lines: changed-since-viewed', async () => {
    // codex P1 — 같은 블록을 다른 자리에 넣은 것이 확인한 블록과 맞춰져 숨던 경우
    const st = await viewedAt(snapAt(ctx(['@@ -5,3 +5,3 @@', ' f1', '-old', '+new', ' f1end']), 'mb1'));
    const it = (await buildReview(snapAt(ctx(['@@ -40,3 +40,3 @@', ' g1', '-old', '+new', ' g1end']), 'mb2'), st, S)).items[0];
    expect(it.state).toBe('changed-since-viewed');
    expect(it.newBlocks).toEqual([0]);
  });

  it('no merge base on the record or on the snapshot: changed-since-viewed', async () => {
    const st = await viewedAt(snapAt(p1, 'mb1'));
    const k = Object.keys(st)[0];
    const { base: _ba, ...noBase } = st[k];
    expect((await buildReview(snapAt(p1rebased, 'mb2'), { [k]: noBase }, S)).items[0].state).toBe('changed-since-viewed');
    const { mergeBase: _mb, ...noMergeBase } = snapAt(p1rebased, 'mb2');
    expect((await buildReview(noMergeBase, st, S)).items[0].state).toBe('changed-since-viewed');
  });

  it('S3 a new block: changed-since-viewed with its index', async () => {
    const st = await viewedAt(snapAt(p1, 'mb1'));
    const it = (await buildReview(snapAt(p3, 'mb2'), st, S)).items[0];
    expect(it.state).toBe('changed-since-viewed');
    expect(it.newBlocks).toEqual([1]);
    expect(it.carried).toBeUndefined();
    expect(it.dropped).toBeUndefined();
  });

  it('a new file changed after the base moved: changed-since-viewed with no block judgment', async () => {
    // 새 파일은 diff 전체가 블록 하나라 블록으로 보면 한 줄만 바뀌어도 파일 전체가 다시 뜬다 — 지운 줄은 아예 안 보인다
    const added = (patch: string, mergeBase: string) => snapAt(patch, mergeBase, { status: 'added' });
    const st = await viewedAt(added(ctx(['@@ -0,0 +1,3 @@', '+a', '+b', '+c']), 'mb1'));
    const it = (await buildReview(added(ctx(['@@ -0,0 +1,2 @@', '+a', '+c']), 'mb2'), st, S)).items[0];
    expect(it.state).toBe('changed-since-viewed');
    expect(it.newBlocks).toBeUndefined();
  });

  it('overlap: same + line but the base - line changed is a new block', async () => {
    const st = await viewedAt(snapAt(ctx(['@@ -8 +8 @@', '-line 8', '+mine']), 'mb1'));
    const it = (await buildReview(snapAt(ctx(['@@ -8 +8 @@', '-line 8 DEV', '+mine']), 'mb2'), st, S)).items[0];
    expect(it.state).toBe('changed-since-viewed');
  });

  it('mode change with identical blocks is changed-since-viewed', async () => {
    const st = await viewedAt(snapAt(p1, 'mb1'));
    expect((await buildReview(snapAt(p1rebased, 'mb2', { mode: '100755' }), st, S)).items[0].state).toBe('changed-since-viewed');
  });

  it('a record from before this feature (no blocks) keeps the old behavior', async () => {
    const st = await viewedAt(snapAt(p1, 'mb1'));
    const k = Object.keys(st)[0];
    const { blocks: _b, base: _ba, meta: _m, ...old } = st[k];
    const it = (await buildReview(snapAt(p1rebased, 'mb2'), { [k]: old }, S)).items[0];
    expect(it.state).toBe('changed-since-viewed');
    expect(it.newBlocks).toBeUndefined();
  });

  it('a file without a patch skips block judgment', async () => {
    const st = await viewedAt(snapAt(p1, 'mb1'));
    expect((await buildReview(snapAt(undefined, 'mb2'), st, S)).items[0].state).toBe('changed-since-viewed');
  });

  it('carried files count toward progress and completion', async () => {
    const st = await viewedAt(snapAt(p1, 'mb1'));
    const r = await buildReview(snapAt(p1rebased, 'mb2'), st, S);
    expect(r).toMatchObject({ viewedCount: 1, complete: true });
  });

  // n 개 블록 — 블록마다 앞에 문맥 줄 하나. 맨 앞 ' top' 은 어느 블록에도 붙지 않아 바꿔도 서명은 그대로다(지문만 바뀐다)
  const manyBlocks = (n: number, top = ' top') =>
    ctx(['@@ -1,999 +1,999 @@', top, ...Array.from({ length: n }, (_, i) => [` c${i}`, `-o${i}`, `+n${i}`]).flat()]);

  it('stores block signatures for up to 300 blocks', async () => {
    const st = await viewedAt(snapAt(manyBlocks(300), 'mb1'));
    expect(Object.values(st)[0].blocks).toHaveLength(300);
    const it = (await buildReview(snapAt(manyBlocks(300, ' top DEV'), 'mb2'), st, S)).items[0];
    expect(it.state).toBe('viewed');
    expect(it.carried).toBe('same');
  });

  it('a file over 300 blocks stores no signatures and keeps the old behavior after a rebase', async () => {
    const st = await viewedAt(snapAt(manyBlocks(301), 'mb1'));
    const rec = Object.values(st)[0];
    expect(rec.blocks).toBeUndefined();
    expect(rec.base).toBe('mb1');
    expect(rec.meta).toMatch(/^[0-9a-f]{16}$/);
    const it = (await buildReview(snapAt(manyBlocks(301, ' top DEV'), 'mb2'), st, S)).items[0];
    expect(it.state).toBe('changed-since-viewed');
    expect(it.carried).toBeUndefined();
    expect(it.newBlocks).toBeUndefined();
  });

  it('the signature cache is keyed by the secret too', async () => {
    // 같은 지문이라도 비밀이 다르면 서명이 다르다 — 캐시가 지문만 보면 다른 비밀의 서명을 돌려준다
    const s = snapAt(p1, 'mb1');
    const a = (await buildReview(s, {}, 'secret-a')).items[0].blocks;
    const b = (await buildReview(s, {}, 'secret-b')).items[0].blocks;
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b).not.toEqual(a);
  });
});

describe('buildReview others', () => {
  it('counts others-only files as viewed with no record', async () => {
    const r = await buildReview(snap([fa, fb]), {}, S, new Map([['a.ts', ['Bob']]]));
    expect(r.items[0]).toMatchObject({ state: 'viewed', others: ['Bob'] });
    expect(r.items[0].newBlocks).toBeUndefined();
    expect(r.items[1].state).toBe('unread');
    expect(r.viewedCount).toBe(1);
  });
  it('completes when all files are others', async () => {
    const r = await buildReview(snap([fa]), {}, S, new Map([['a.ts', ['Bob']]]));
    expect(r.complete).toBe(true);
  });
  it('others wins over a stale record', async () => {
    const key = await recordKey(S, 'acme', 'widget', 'feat', 'a.ts');
    const st: DeviceState = { [key]: { fp: 'old', blob: 'a0', head: 'h1', at: 't', viewed: true } };
    const r = await buildReview(snap([fa]), st, S, new Map([['a.ts', ['Bob']]]));
    expect(r.items[0]).toMatchObject({ state: 'viewed', others: ['Bob'] });
    expect(r.items[0].carried).toBeUndefined();
  });
  it('no others argument is unchanged', async () => {
    const r = await buildReview(snap([fa]), {}, S);
    expect(r.items[0].others).toBeUndefined();
    expect(r.items[0].state).toBe('unread');
  });
});
