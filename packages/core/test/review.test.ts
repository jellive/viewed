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
    const r = await buildReview(snap([{ ...fa, patch: 'pa2', blobSha: 'a2' }, fb]), state, S);
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
      '/compare/main...h9': { files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: 'p' }] },
      '/git/trees/h9?recursive=1': { truncated: false, tree: [{ path: 'a.ts', mode: '100755', type: 'blob' }] },
    };
    const f: FetchLike = async (url) => {
      const k = Object.keys(routes).find((p) => url.endsWith(p));
      return k ? new Response(JSON.stringify(routes[k])) : new Response('', { status: 404 });
    };
    const s = await loadSnapshot(new GitHub('t', f), 'acme', 'widget', 'feat');
    expect(s).toMatchObject({ base: 'main', headSha: 'h9', truncated: false });
    expect(s.files[0].mode).toBe('100755');
  });
});
