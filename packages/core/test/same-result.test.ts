import { describe, it, expect, vi } from 'vitest';
import { buildReview, markRecord } from '../src/review';
import { otherBranchCarry, sameResultCarry } from '../src/carry';
import { fingerprint } from '../src/fingerprint';
import type { ChangedFile, DeviceState, Review, Snapshot, ViewRecord } from '../src/types';

// 대상을 옮겨 diff 만 달라진 파일. 결과 파일이 확인 때와 같을 때, 지금 변경이 전부 그때 본 변경인지 결과 파일 좌표로 맞댄다
const S = 'secret';
const N = 'n'.repeat(40), P = 'p'.repeat(40);
const snap = (files: ChangedFile[], mergeBase = N): Snapshot =>
  ({ owner: 'local', repo: 'r', base: 'refs/heads/test', branch: 'refs/heads/feat', headSha: 'h'.repeat(40), files, truncated: false, mergeBase });
const mod = (patch: string, extra: Partial<ChangedFile> = {}): ChangedFile =>
  ({ path: 'a.ts', status: 'modified', blobSha: 'same', patch, mode: '100644', oldMode: '100644', ...extra });
const L = (...lines: string[]) => lines.join('\n');

// 두 줄을 고친 블록(결과 파일 109~110줄)을 봤는데, 새 대상에는 첫 줄 변경이 이미 들어가 있다. 블록 서명은 안 맞는다
const SEEN = L('@@ -108,4 +108,4 @@', ' c', '-x', '-y', '+X', '+Y', ' d');
const NOW = L('@@ -109,3 +109,3 @@', ' X', '-y', '+Y', ' d');

async function moved(seen: ChangedFile, now: ChangedFile, rec: Partial<ViewRecord> = {}, others?: Map<string, string[]>): Promise<Review> {
  const first = await buildReview(snap([seen], P), {}, S);
  const state: DeviceState = { [first.items[0].key]: { ...markRecord(first.items[0], 'old', true), ...rec } };
  return buildReview(snap([now]), state, S, others);
}
const carry = async (review: Review, seen: ChangedFile[]) => (await sameResultCarry(review, N, async (b) => (b === P ? seen : null))).carried;
const paths = (items: { file: ChangedFile }[]) => items.map((i) => i.file.path);

describe('sameResultCarry', () => {
  it('carries a file whose result is unchanged and whose changes were all in the viewed diff, remembering the old target', async () => {
    const seen = mod(SEEN), review = await moved(seen, mod(NOW));
    expect(review.items[0].state).toBe('changed-since-viewed');
    const [it0] = await carry(review, [seen]);
    expect(it0?.file.path).toBe('a.ts');
    expect(it0.carryPrev).toEqual({ base: P, fp: await fingerprint(seen) });
  });

  it('keeps where the old record came from', async () => {
    const seen = mod(SEEN), [it0] = await carry(await moved(seen, mod(NOW), { via: 'branch' }), [seen]);
    expect(it0.carryPrev?.via).toBe('branch');
  });

  it('after carrying it is viewed here and still viewed back on the old target', async () => {
    const seen = mod(SEEN), now = mod(NOW);
    const review = await moved(seen, now);
    const [it0] = await carry(review, [seen]);
    const state: DeviceState = { [it0.key]: { ...markRecord(it0, 'h', true), via: 'target' } };
    const here = (await buildReview(snap([now]), state, S)).items[0];
    expect([here.state, here.carriedOver, here.auto]).toEqual(['viewed', true, true]);
    const back = (await buildReview(snap([seen], P), state, S)).items[0];
    expect([back.state, back.carriedOver]).toEqual(['viewed', undefined]);
  });

  it('carries a file that was new on the old target and is modified on the new one when nothing is removed', async () => {
    const seen = mod(L('@@ -0,0 +1,3 @@', '+a', '+b', '+c'), { status: 'added', oldMode: '000000' });
    const now = mod(L('@@ -1,2 +1,3 @@', ' a', '+b', ' c'));
    expect(paths(await carry(await moved(seen, now), [seen]))).toEqual(['a.ts']);
  });

  it('does not carry a line removed for the first time, even from a file seen whole', async () => {
    const seen = mod(L('@@ -0,0 +1,3 @@', '+a', '+b', '+c'), { status: 'added', oldMode: '000000' });
    const now = mod(L('@@ -1,3 +1,3 @@', ' a', '-old', '+b', ' c'));
    expect(await carry(await moved(seen, now), [seen])).toEqual([]);
  });

  it('does not carry the same text removed in another place', async () => {
    // 그때는 sandbox 의 인증 호출 삭제를 봤고, 지금 diff 는 production 의 것을 지운다. 글자는 같다
    const seen = mod(L('@@ -1,4 +1,3 @@', ' function sandbox() {', '-  authorize();', '   runSandbox();', ' }'));
    const now = mod(L('@@ -20,4 +20,3 @@', ' function production() {', '-  authorize();', '   runProduction();', ' }'));
    expect(await carry(await moved(seen, now), [seen])).toEqual([]);
  });

  it('carries a removed line anywhere inside the block it was viewed in', async () => {
    // 본 블록이 결과 파일 2~3줄을 차지했다. 지금은 그 두 줄이 대상에 있고 삭제만 그 끝에 남는다
    const seen = mod(L('@@ -1,3 +1,4 @@', ' a', '-x', '+X', '+Y', ' b', ' c'));
    const now = mod(L('@@ -2,4 +2,3 @@', ' X', ' Y', '-x', ' b', ' c'));
    expect(paths(await carry(await moved(seen, now), [seen]))).toEqual(['a.ts']);
  });

  it('does not carry a removed line just past the block it was viewed in', async () => {
    // 본 블록은 결과 파일 2~3줄 앞까지다. 한 줄 뒤(문맥 건너)의 같은 삭제는 다른 자리다
    const seen = mod(L('@@ -1,3 +1,3 @@', ' a', '-x', '+X', ' b', ' c'));
    const now = mod(L('@@ -3,3 +3,2 @@', ' b', '-x', ' c'));
    expect(await carry(await moved(seen, now), [seen])).toEqual([]);
  });

  it('does not carry a removed line just before the block it was viewed in', async () => {
    const seen = mod(L('@@ -3,4 +3,4 @@', ' b', ' c', '-x', '+X', ' d'));
    const now = mod(L('@@ -3,3 +3,2 @@', ' b', '-x', ' c', ' X'));
    expect(await carry(await moved(seen, now), [seen])).toEqual([]);
  });

  it('does not carry when a line is removed more times than was viewed', async () => {
    const seen = mod(L('@@ -1,3 +1,2 @@', ' a', '-dup', ' b'));
    const now = mod(L('@@ -1,4 +1,2 @@', ' a', '-dup', '-dup', ' b'));
    expect(await carry(await moved(seen, now), [seen])).toEqual([]);
  });

  it('does not carry a line added here that was only context in the viewed diff', async () => {
    const seen = mod(L('@@ -1,3 +1,3 @@', ' a', '-x', '+y', ' c'));
    const now = mod(L('@@ -1,1 +1,2 @@', '+a', ' y'));
    expect(await carry(await moved(seen, now), [seen])).toEqual([]);
  });

  it('counts a missing end-of-file newline as part of the removed line', async () => {
    const seen = mod(L('@@ -1,2 +1,2 @@', ' a', '-x', '+y', '\\ No newline at end of file'));
    const now = mod(L('@@ -1,2 +1,2 @@', ' a', '-x', '\\ No newline at end of file', '+y'));
    expect(await carry(await moved(seen, now), [seen])).toEqual([]);
    const seen2 = mod(L('@@ -1,3 +1,3 @@', ' a', '-w', '-x', '\\ No newline at end of file', '+W', '+y', '\\ No newline at end of file'));
    const now2 = mod(L('@@ -2,2 +2,2 @@', ' W', '-x', '\\ No newline at end of file', '+y', '\\ No newline at end of file'));
    expect(paths(await carry(await moved(seen2, now2), [seen2]))).toEqual(['a.ts']);
  });

  it('carries removed files by their removed lines', async () => {
    const gone = { status: 'removed' as const, blobSha: null, mode: undefined };
    const seen = mod(L('@@ -1,3 +0,0 @@', '-a', '-b', '-c'), gone);
    expect(paths(await carry(await moved(seen, mod(L('@@ -1,2 +0,0 @@', '-b', '-c'), gone)), [seen]))).toEqual(['a.ts']);
    expect(await carry(await moved(seen, mod(L('@@ -1,2 +0,0 @@', '-b', '-z'), gone)), [seen])).toEqual([]);
  });

  describe('file mode', () => {
    it('does not carry a mode change that was not in the viewed diff', async () => {
      // 결과 mode 는 양쪽 다 644 지만 지금 diff 는 대상의 실행 권한을 없앤다
      const seen = mod(SEEN);
      expect(await carry(await moved(seen, mod(NOW, { oldMode: '100755' })), [seen])).toEqual([]);
    });
    it('carries the same mode change that was viewed', async () => {
      const seen = mod(SEEN, { oldMode: '100755' });
      expect(paths(await carry(await moved(seen, mod(NOW, { oldMode: '100755' })), [seen]))).toEqual(['a.ts']);
    });
    it('does not carry when the result mode differs', async () => {
      const seen = mod(SEEN);
      expect(await carry(await moved(seen, mod(NOW, { mode: '100755', oldMode: '100755' })), [seen])).toEqual([]);
    });
  });

  describe('what it refuses to look at', () => {
    it('a result file that changed since it was viewed', async () => {
      const seen = mod(SEEN);
      expect(await carry(await moved(seen, mod(NOW, { blobSha: 'other' })), [seen])).toEqual([]);
    });
    it('a rebuilt diff that is not the one viewed', async () => {
      const seen = mod(SEEN);
      expect(await carry(await moved(seen, mod(NOW)), [mod(L('@@ -108,4 +108,4 @@', ' cc', '-x', '-y', '+X', '+Y', ' d'))])).toEqual([]);
    });
    it('a file missing from the rebuilt diff', async () => {
      expect(await carry(await moved(mod(SEEN), mod(NOW)), [])).toEqual([]);
    });
    it('a rename the viewed diff did not have', async () => {
      const seen = mod(SEEN);
      expect(await carry(await moved(seen, mod(NOW, { status: 'renamed', previousPath: 'old.ts' })), [seen])).toEqual([]);
    });
    it('a file without a diff', async () => {
      const seen = mod(SEEN);
      expect(await carry(await moved(seen, { path: 'a.ts', status: 'modified', blobSha: 'same', mode: '100644', oldMode: '100644' }), [seen])).toEqual([]);
    });
    it('a check that was undone', async () => {
      const seen = mod(SEEN);
      expect(await carry(await moved(seen, mod(NOW), { viewed: false }), [seen])).toEqual([]);
    });
    it('other people\'s files', async () => {
      const seen = mod(SEEN);
      expect(await carry(await moved(seen, mod(NOW), {}, new Map([['a.ts', ['bob']]])), [seen])).toEqual([]);
    });
    it('a file with no record', async () => {
      expect(await carry(await buildReview(snap([mod(NOW)]), {}, S), [mod(SEEN)])).toEqual([]);
    });
    it('a record already on this target', async () => {
      const seen = mod(SEEN);
      const first = await buildReview(snap([seen]), {}, S);
      const state = { [first.items[0].key]: markRecord(first.items[0], 'old', true) };
      expect((await sameResultCarry(await buildReview(snap([mod(NOW)]), state, S), N, async () => [seen])).carried).toEqual([]);
    });
  });

  describe('which old targets it reads', () => {
    const at = (path: string) => ({ seen: mod(SEEN, { path }), now: mod(NOW, { path }) });
    async function review(bases: [string, string][]) {
      const fs = bases.map(([p]) => at(p));
      const state: DeviceState = {};
      for (const [i, f] of fs.entries()) {
        const it0 = (await buildReview(snap([f.seen], bases[i][1]), {}, S)).items[0];
        state[it0.key] = markRecord(it0, 'old', true);
      }
      return { r: await buildReview(snap(fs.map((f) => f.now)), state, S), fs };
    }
    const b = (c: string) => c.repeat(40);

    it('reads only the three with the most candidates, ties in name order', async () => {
      const { r, fs } = await review([['a', b('4')], ['b', b('1')], ['c', b('1')], ['d', b('1')], ['e', b('2')], ['f', b('2')], ['g', b('3')]]);
      const load = vi.fn(async (_b: string) => fs.map((f) => f.seen));
      const { carried: out } = await sameResultCarry(r, N, load);
      expect(load.mock.calls.map(([x]) => x)).toEqual([b('1'), b('2'), b('3')]);
      expect(paths(out).sort()).toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
    });

    it('reads nothing when there is no candidate', async () => {
      const load = vi.fn(async () => []);
      expect((await sameResultCarry(await buildReview(snap([mod(NOW)]), {}, S), N, load)).carried).toEqual([]);
      expect(load).not.toHaveBeenCalled();
    });

    it('skips a target it cannot read and still uses the others', async () => {
      const { r, fs } = await review([['a', b('1')], ['b', b('2')]]);
      const load = async (x: string) => { if (x === b('1')) throw new Error('boom'); return fs.map((f) => f.seen); };
      expect(paths((await sameResultCarry(r, N, load)).carried)).toEqual(['b']);
      const nullLoad = async (x: string) => (x === b('1') ? null : fs.map((f) => f.seen));
      expect(paths((await sameResultCarry(r, N, nullLoad)).carried)).toEqual(['b']);
    });
  });
});

describe('lines never seen', () => {
  // NOW 에 처음 보는 덩어리 하나를 더한 diff. 줄 번호: 0 머리, 1 X, 2 -y, 3 +Y, 4 d, 5 머리, 6 e, 7 -z, 8 +Z
  const MORE = L('@@ -109,3 +109,3 @@', ' X', '-y', '+Y', ' d', '@@ -200,2 +200,2 @@', ' e', '-z', '+Z');
  const load = (seen: ChangedFile) => async (b: string) => (b === P ? [seen] : null);

  it('reports the patch lines of a file it cannot carry, keyed by the file as it is now', async () => {
    const seen = mod(SEEN), review = await moved(seen, mod(MORE));
    const { carried, lines } = await sameResultCarry(review, N, load(seen));
    expect(carried).toEqual([]);
    expect(lines.get('a.ts')).toEqual({ fp: review.items[0].fp, lines: [7, 8] });
  });

  it('says nothing about a file it carries', async () => {
    const seen = mod(SEEN);
    const { carried, lines } = await sameResultCarry(await moved(seen, mod(NOW)), N, load(seen));
    expect(paths(carried)).toEqual(['a.ts']);
    expect(lines.size).toBe(0);
  });

  it('does not count the end-of-file marker as a line of its own', async () => {
    const seen = mod(L('@@ -1,2 +1,2 @@', ' a', '-x', '+y'));
    const now = mod(L('@@ -1,2 +1,2 @@', ' a', '-other', '\\ No newline at end of file', '+y'));
    const review = await moved(seen, now);
    expect((await sameResultCarry(review, N, load(seen))).lines.get('a.ts')?.lines).toEqual([2]);
  });

  it.each([
    ['the result file changed', { blobSha: 'other' }],
    ['the mode changed', { oldMode: '100755' }],
    ['it was renamed', { status: 'renamed' as const, previousPath: 'old.ts' }],
  ])('says nothing when %s', async (_n, extra) => {
    const seen = mod(SEEN);
    expect((await sameResultCarry(await moved(seen, mod(MORE, extra)), N, load(seen))).lines.size).toBe(0);
  });

  it('neither carries nor marks a diff it cannot read', async () => {
    const seen = mod(SEEN);
    const { carried, lines } = await sameResultCarry(await moved(seen, mod(L('@@ not a hunk header', '-y'))), N, load(seen));
    expect(carried).toEqual([]);
    expect(lines.size).toBe(0);
  });

  it('says nothing when the rebuilt diff is not the one viewed', async () => {
    const review = await moved(mod(SEEN), mod(MORE));
    const other = mod(L('@@ -108,4 +108,4 @@', ' cc', '-x', '-y', '+X', '+Y', ' d'));
    expect((await sameResultCarry(review, N, load(other))).lines.size).toBe(0);
  });

  describe('buildReview', () => {
    const hint = (fp: string) => new Map([['a.ts', { fp, lines: [7, 8] }]]);
    async function withHint(state: DeviceState, fpOf: (fp: string) => string = (x) => x) {
      const now = snap([mod(MORE)]);
      const fp = (await buildReview(now, {}, S)).items[0].fp;
      return (await buildReview(now, state, S, undefined, undefined, undefined, hint(fpOf(fp)))).items[0];
    }
    async function recordOf(viewed = true) {
      const first = await buildReview(snap([mod(SEEN)], P), {}, S);
      return { [first.items[0].key]: { ...markRecord(first.items[0], 'old', true), viewed } } as DeviceState;
    }

    it('puts them on a changed file', async () => {
      const it0 = await withHint(await recordOf());
      expect([it0.state, it0.newLines, it0.elsewhere]).toEqual(['changed-since-viewed', [7, 8], undefined]);
    });
    it('ignores them once a new commit changed the diff', async () => {
      const it0 = await withHint(await recordOf(), () => 'old-fingerprint');
      expect([it0.state, it0.newLines]).toEqual(['changed-since-viewed', undefined]);
    });
    it('does not put them on a file whose check was undone here', async () => {
      const it0 = await withHint(await recordOf(false));
      expect([it0.state, it0.newLines]).toEqual(['unread', undefined]);
    });
    it('does not put them on a file checked here', async () => {
      const first = await buildReview(snap([mod(MORE)]), {}, S);
      const it0 = await withHint({ [first.items[0].key]: markRecord(first.items[0], 'old', true) });
      expect([it0.state, it0.newLines]).toEqual(['viewed', undefined]);
    });
    it('shows a file with no record here as seen elsewhere', async () => {
      const it0 = await withHint({});
      expect([it0.state, it0.newLines, it0.elsewhere]).toEqual(['changed-since-viewed', [7, 8], true]);
    });
    it('leaves a file with no record unread once the diff changed', async () => {
      const it0 = await withHint({}, () => 'old-fingerprint');
      expect([it0.state, it0.newLines, it0.elsewhere]).toEqual(['unread', undefined, undefined]);
    });
    it('wins over blocks from another branch, which stay as the fallback', async () => {
      const near = new Map([['a.ts', { blocks: ['nope'] }]]);
      const now = snap([mod(MORE)]);
      const r0 = (await buildReview(now, {}, S)).items[0];
      const a = (await buildReview(now, {}, S, undefined, undefined, near, hint(r0.fp))).items[0];
      expect([a.state, a.newLines, a.newBlocks]).toEqual(['changed-since-viewed', [7, 8], undefined]);
    });
  });
});

describe('otherBranchCarry', () => {
  const FEAT = 'refs/heads/feat', FEAT2 = 'refs/heads/feat2', OTHER = 'refs/heads/other';
  const here = (files: ChangedFile[]) => ({ ...snap(files), branch: FEAT2 });
  const MORE = L('@@ -109,3 +109,3 @@', ' X', '-y', '+Y', ' d', '@@ -200,2 +200,2 @@', ' e', '-z', '+Z');
  const AT = (d: number) => new Date(`2026-10-${String(d).padStart(2, '0')}T00:00:00Z`);

  // branch 에서 file 을 base 기준으로 d 일에 체크한(viewed=false 면 풀어 둔) 기록을 state 에 넣는다
  async function on(state: DeviceState, branch: string, file: ChangedFile, d: number, viewed = true, base = P) {
    const it0 = (await buildReview({ ...snap([file], base), branch }, {}, S)).items[0];
    state[it0.key] = markRecord(it0, 'old', viewed, AT(d));
    return state;
  }
  const open = async (now: ChangedFile, state: DeviceState) => {
    const s = here([now]);
    return { s, review: await buildReview(s, state, S) };
  };
  const run = async (now: ChangedFile, state: DeviceState, seen: ChangedFile[], branches = [FEAT, FEAT2, OTHER]) => {
    const { s, review } = await open(now, state);
    return otherBranchCarry(review, s, state, S, branches, async (b) => (b === P ? seen : null));
  };

  it('carries a file with no record here when its changes were all viewed on another branch, without an old target to return to', async () => {
    const seen = mod(SEEN), { carried, lines } = await run(mod(NOW), await on({}, FEAT, seen, 1), [seen]);
    expect(paths(carried)).toEqual(['a.ts']);
    expect(carried[0].carryPrev).toBeUndefined();
    expect(lines.size).toBe(0);
  });

  it('reports lines never seen on a file it cannot carry', async () => {
    const seen = mod(SEEN), { carried, lines } = await run(mod(MORE), await on({}, FEAT, seen, 1), [seen]);
    expect(carried).toEqual([]);
    expect(lines.get('a.ts')?.lines).toEqual([7, 8]);
  });

  it('leaves a file whose check was undone on this branch alone', async () => {
    // 이 브랜치에서 푼 기록이 다른 브랜치의 확인보다 이긴다
    const seen = mod(SEEN), state = await on({}, FEAT, seen, 1);
    await on(state, FEAT2, mod(NOW), 2, false, N);
    const { carried, lines } = await run(mod(NOW), state, [seen]);
    expect(carried).toEqual([]);
    expect(lines.size).toBe(0);
  });

  // 시각이 정하지 브랜치 순서가 정하지 않는다
  it.each([[[FEAT, OTHER]], [[OTHER, FEAT]]])('a later uncheck of the same content on another branch wins, branches %j', async (branches) => {
    const seen = mod(SEEN), state = await on({}, FEAT, seen, 1);
    await on(state, OTHER, mod(MORE), 2, false);
    const load = vi.fn(async () => [seen]);
    const { s, review } = await open(mod(NOW), state);
    expect((await otherBranchCarry(review, s, state, S, branches, load)).carried).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([[[FEAT, OTHER]], [[OTHER, FEAT]]])('an earlier uncheck of the same content does not, branches %j', async (branches) => {
    const seen = mod(SEEN), state = await on({}, FEAT, seen, 2);
    await on(state, OTHER, mod(MORE), 1, false);
    expect(paths((await run(mod(NOW), state, [seen], branches)).carried)).toEqual(['a.ts']);
  });

  it('an uncheck of different content is about something else', async () => {
    const seen = mod(SEEN), state = await on({}, FEAT, seen, 1);
    await on(state, OTHER, mod(MORE, { blobSha: 'other' }), 2, false);
    expect(paths((await run(mod(NOW), state, [seen], [FEAT, OTHER])).carried)).toEqual(['a.ts']);
  });

  it('a record of different content is not used, however new', async () => {
    const seen = mod(SEEN, { blobSha: 'other' });
    expect((await run(mod(NOW), await on({}, FEAT, seen, 1), [seen])).carried).toEqual([]);
  });

  it('does not read a diff it already has', async () => {
    const seen = mod(SEEN), state = await on({}, FEAT, seen, 1, true, N);
    const load = vi.fn(async () => [seen]);
    const { s, review } = await open(mod(NOW), state);
    expect((await otherBranchCarry(review, s, state, S, [FEAT], load)).carried).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it('skips files already viewed, files without a diff, and the branch itself', async () => {
    const seen = mod(SEEN), state = await on({}, FEAT, seen, 1);
    const load = vi.fn(async () => [seen]);
    const noDiff = { path: 'a.ts', status: 'modified' as const, blobSha: 'same', mode: '100644', oldMode: '100644' };
    const a = await open(noDiff, state);
    expect((await otherBranchCarry(a.review, a.s, state, S, [FEAT], load)).carried).toEqual([]);
    const others = new Map([['a.ts', ['bob']]]);
    const s = here([mod(NOW)]);
    expect((await otherBranchCarry(await buildReview(s, state, S, others), s, state, S, [FEAT], load)).carried).toEqual([]);
    const own = await on({}, FEAT2, seen, 1);
    const b = await open(mod(NOW), own);
    expect((await otherBranchCarry({ ...b.review, items: b.review.items.map((i) => ({ ...i, record: undefined })) }, b.s, own, S, [FEAT2], load)).carried).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});
