import { describe, it, expect } from 'vitest';
import { buildReview, markRecord } from '../src/review';
import type { ChangedFile, DeviceState, ReviewItem, Snapshot } from '../src/types';

// 직접 체크와 자동 처리를 가른다. 자동 = 앱이 확인으로 친 것 — 남의 파일, 다른 기록에서 이어받은 것
const S = 'secret';
const MB = 'm'.repeat(40), OLD = 'o'.repeat(40);
const hunk = (at: number, from: string, to: string) => `@@ -${at},3 +${at},3 @@\n c${at}\n-${from}\n+${to}\n c${at + 2}`;
const file = (path: string, patch: string, blob = 'b-' + patch): ChangedFile => ({ path, status: 'modified', blobSha: blob, patch, mode: '100644' });
const snap = (files: ChangedFile[], mergeBase = MB): Snapshot =>
  ({ owner: 'local', repo: 'github.com/x/y', base: 'refs/heads/main', branch: 'refs/heads/feat', headSha: 'h'.repeat(40), files, truncated: false, mergeBase });
const X = hunk(1, 'a', 'A'), Y = hunk(10, 'b', 'B');
const auto = (it: ReviewItem) => !!it.auto;

async function keep(files: ChangedFile[], via?: 'branch' | 'target', mergeBase = MB): Promise<DeviceState> {
  const r = await buildReview(snap(files, mergeBase), {}, S);
  const state: DeviceState = {};
  for (const it of r.items) state[it.key] = { ...markRecord(it, 'a'.repeat(40), true), ...(via ? { via } : {}) };
  return state;
}

describe('automatic and direct checks', () => {
  it('a file checked by hand is direct, and an old record without the field reads the same', async () => {
    const files = [file('a.ts', X)];
    const r = await buildReview(snap(files), await keep(files), S);
    expect(r.items[0].state).toBe('viewed');
    expect(auto(r.items[0])).toBe(false);
    expect(r.autoCount).toBe(0);
  });

  it("someone else's file and a carried-over record count as automatic", async () => {
    const files = [file('a.ts', X), file('b.ts', Y), file('c.ts', X)];
    const state = { ...await keep([files[0]], 'branch'), ...await keep([files[1]], 'target') };
    const r = await buildReview(snap(files), state, S, new Map([['c.ts', ['bob']]]));
    expect(r.items.map(auto)).toEqual([true, true, true]);
    expect(r.autoCount).toBe(3);
    expect(r.viewedCount).toBe(3);
  });

  it('a carried-over record stops counting once the file changed: it is no longer viewed', async () => {
    const state = await keep([file('a.ts', X)], 'branch');
    const r = await buildReview(snap([file('a.ts', Y)]), state, S);
    expect(r.items[0].state).toBe('changed-since-viewed');
    expect(auto(r.items[0])).toBe(false);
    expect(r.autoCount).toBe(0);
  });

  it('a direct check that survives a rebase stays direct, a carried-over one stays automatic', async () => {
    const files = [file('a.ts', X)];
    // base 가 움직이고 diff 머리만 달라졌다 — 블록이 맞아 확인함으로 남는다
    const moved = [file('a.ts', X + '\n')];
    for (const [via, want] of [[undefined, false], ['branch', true]] as const) {
      const r = await buildReview(snap(moved, MB), await keep(files, via, OLD), S);
      expect(r.items[0].carried).toBe('same');
      expect(auto(r.items[0])).toBe(want);
    }
  });

  it('checking again by hand drops the automatic mark', async () => {
    const files = [file('a.ts', X)];
    const state = await keep(files, 'branch');
    const r = await buildReview(snap(files), state, S);
    expect(auto(r.items[0])).toBe(true);
    state[r.items[0].key] = markRecord(r.items[0], 'h'.repeat(40), false);
    expect((await buildReview(snap(files), state, S)).items[0].state).toBe('unread');
    state[r.items[0].key] = markRecord(r.items[0], 'h'.repeat(40), true);
    const again = await buildReview(snap(files), state, S);
    expect(again.items[0].state).toBe('viewed');
    expect(auto(again.items[0])).toBe(false);
  });
});
