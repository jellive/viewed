import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalSnapshot, loadLocalRange, type LocalGit } from '../src/local';
import { buildReview, markRecord } from '../src/review';
import { mergeStates } from '../src/sync';
import { carryBases, targetCarry } from '../src/carry';
import type { DeviceState, Snapshot } from '../src/types';

function gitFor(dir: string): LocalGit {
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const diff = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '-M', '--no-abbrev'];
  return {
    resolve: async (ref) => g('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim(),
    mergeBase: async (a, b) => g('merge-base', a, b).trim(),
    rawDiff: async (a, b) => g(...diff, '--raw', '-z', a, b),
    patchDiff: async (a, b) => g(...diff, '-p', '-U3', '--diff-algorithm=myers', a, b),
  };
}
const S = 'secret';
const states = (r: { items: { file: { path: string }; state: string }[] }) => Object.fromEntries(r.items.map((i) => [i.file.path, i.state]));

// makeCarry 와 같은 순서(조상 판정 → P-diff → targetCarry), useReview 처럼 기록을 쓴다
async function carry(git: LocalGit, snap: Snapshot, state: DeviceState): Promise<DeviceState> {
  const review = await buildReview(snap, state, S);
  const n = snap.mergeBase!;
  const prev = [];
  for (const p of carryBases(review, n)) {
    if (p === n || (await git.mergeBase(n, p)) !== n) continue;
    prev.push({ base: p, files: await loadLocalRange(git, p, snap.headSha) });
  }
  const items = prev.length ? await targetCarry(review, n, prev) : [];
  return mergeStates([state, Object.fromEntries(items.map((it) => [it.key, markRecord(it, snap.headSha, true)]))]);
}

it('round trip integ -> main (carry) -> integ keeps files carried via (b) viewed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'viewed-probe-'));
  const as = (who: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', `user.name=${who}`, '-c', `user.email=${who}@example.test`, ...a], { encoding: 'utf8' });
  const put = (f: string, c: string) => writeFileSync(join(dir, f), c);
  as('alice', 'init', '-q', '-b', 'main');
  put('a.ts', 'a\n'); as('alice', 'add', '-A'); as('alice', 'commit', '-q', '-m', 'base');
  as('alice', 'checkout', '-q', '-b', 'integ');
  put('w.ts', 'w\n'); as('alice', 'add', '-A'); as('alice', 'commit', '-q', '-m', 'integ w');
  put('y.ts', 'y\n1\n2\n3\n'); as('bob', 'add', '-A'); as('bob', 'commit', '-q', '-m', 'integ y (new file)');
  as('alice', 'checkout', '-q', '-b', 'feat');
  put('y.ts', 'y\n1\n2\n3-feat\n'); put('z.ts', 'z\n'); as('alice', 'add', '-A'); as('alice', 'commit', '-q', '-m', 'feat');
  const git = gitFor(dir);

  // 1) integ 기준으로 열어 전부 체크
  const snapP = await loadLocalSnapshot(git, 'r', 'refs/heads/feat', 'refs/heads/integ');
  const rP0 = await buildReview(snapP, {}, S);
  const s1: DeviceState = Object.fromEntries(rP0.items.map((it) => [it.key, markRecord(it, snapP.headSha, true)]));
  expect(states(await buildReview(snapP, s1, S))).toEqual({ 'y.ts': 'viewed', 'z.ts': 'viewed' });

  // 2) main 기준으로 다시 연다 — 오늘 로직 vs 이어받기
  const snapN = await loadLocalSnapshot(git, 'r', 'refs/heads/feat', 'refs/heads/main');
  const before = states(await buildReview(snapN, s1, S));
  expect(before['y.ts']).not.toBe('viewed');
  const s2 = await carry(git, snapN, s1);
  const after = states(await buildReview(snapN, s2, S));

  // 3) 다시 integ 로 연다(Recent 로 오가는 경우) — 기록 s1(이어받기 없음) vs s2(이어받기 씀)
  const backWithout = states(await buildReview(snapP, s1, S));
  const backWith = states(await buildReview(snapP, s2, S));
  expect(after).toEqual({ 'w.ts': 'viewed', 'y.ts': 'viewed', 'z.ts': 'viewed' });
  expect(backWithout['y.ts']).toBe('viewed');
  expect(backWith).toEqual(backWithout);   // 왕복해도 확인한 채 그대로
  // (b) 로 이어받은 y.ts 만 prev 를 갖는다 — (a) 로 이어받은 w.ts 는 P-diff 에 없어 돌아가도 목록에 없다
  expect(Object.values(s2).filter((r) => r.prev).length).toBe(1);
  expect(Object.values(s2).filter((r) => r.base === snapN.mergeBase).length).toBe(2);
});
