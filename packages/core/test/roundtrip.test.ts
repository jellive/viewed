import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalSnapshot, loadLocalRange, type LocalGit } from '../src/local';
import { buildReview, markRecord } from '../src/review';
import { mergeStates } from '../src/sync';
import { carryBases, sameResultCarry, targetCarry } from '../src/carry';
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

describe('moving to a target that has part of the branch (real git)', () => {
  const lines = (n: number, edit: Record<number, string | null> = {}) => {
    const out: string[] = [];
    for (let i = 1; i <= n; i++) { const e = edit[i]; if (e !== null) out.push(e ?? `line ${i}`); }
    return out.join('\n') + '\n';
  };
  // main 에서 feat 를 따서 result 로 만들고, 그 사이 target 은 main 에서 갈라져 mid 가 된다. feat 는 target 을 머지해 결과를 result 로 맞춘다.
  // 그러면 main 대비 diff 와 target 대비 diff 의 결과 파일이 같다
  function repo(a: { start: string; mid: string; result: string; midMode?: string }) {
    const dir = mkdtempSync(join(tmpdir(), 'viewed-probe-'));
    const g = (...x: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=a', '-c', 'user.email=a@example.test', ...x], { encoding: 'utf8' });
    const put = (c: string) => writeFileSync(join(dir, 'a.ts'), c);
    g('init', '-q', '-b', 'main');
    put(a.start); g('add', '-A'); g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'target');
    put(a.mid); if (a.midMode) chmodSync(join(dir, 'a.ts'), a.midMode); g('add', '-A'); g('commit', '-q', '-m', 'target');
    g('checkout', '-q', '-b', 'feat', 'main');
    put(a.result); g('add', '-A'); g('commit', '-q', '-m', 'feat');
    g('merge', '-q', '--no-commit', '-s', 'ours', 'target');
    put(a.result); chmodSync(join(dir, 'a.ts'), '644'); g('add', '-A'); g('commit', '-q', '-m', 'merge target');
    return gitFor(dir);
  }
  async function open(git: LocalGit) {
    const before = await loadLocalSnapshot(git, 'r', 'refs/heads/feat', 'refs/heads/main');
    const first = await buildReview(before, {}, S);
    const state: DeviceState = Object.fromEntries(first.items.map((it) => [it.key, markRecord(it, before.headSha, true)]));
    const now = await loadLocalSnapshot(git, 'r', 'refs/heads/feat', 'refs/heads/target');
    const review = await buildReview(now, state, S);
    expect(now.mergeBase).not.toBe(before.mergeBase);
    expect(review.items[0].state).toBe('changed-since-viewed');
    return { before, now, state, review, carried: await sameResultCarry(review, now.mergeBase!, (p) => loadLocalRange(git, p, now.headSha)) };
  }

  it('a two-line block whose first line the target already has is carried, and viewed again back on the old target', async () => {
    const git = repo({ start: lines(30), mid: lines(30, { 10: 'NEW 10' }), result: lines(30, { 10: 'NEW 10', 11: 'NEW 11', 20: 'NEW 20' }) });
    const { before, now, state, review, carried } = await open(git);
    expect(review.items[0].file.patch).toContain('-line 11');
    expect(review.items[0].file.patch).not.toContain('-line 10');
    expect(carried.map((i) => i.file.path)).toEqual(['a.ts']);
    const s2 = mergeStates([state, Object.fromEntries(carried.map((it) => [it.key, markRecord(it, now.headSha, true)]))]);
    expect(states(await buildReview(now, s2, S))).toEqual({ 'a.ts': 'viewed' });
    expect(states(await buildReview(before, s2, S))).toEqual({ 'a.ts': 'viewed' });
  });

  it('the same text removed in another function on the new target is not carried', async () => {
    const fns = (a: string, b: string) => ['function sandbox() {', ...(a ? [a] : []), '  runSandbox();', '}', ...Array.from({ length: 12 }, (_, i) => `// ${i}`), 'function production() {', ...(b ? [b] : []), '  runProduction();', '}', ''].join('\n');
    const git = repo({ start: fns('  authorize();', ''), mid: fns('', '  authorize();'), result: fns('', '') });
    const { review, carried } = await open(git);
    expect(review.items[0].file.patch).toContain('-  authorize();');
    expect(carried).toEqual([]);
  });

  it('a line the diff adds for the first time is not carried', async () => {
    // 그때는 11줄이 main 에도 있어 문맥이었다. target 이 그 줄을 지워 지금 diff 에는 추가로 나온다
    const git = repo({ start: lines(30), mid: lines(30, { 11: null }), result: lines(30, { 20: 'NEW 20' }) });
    const { review, carried } = await open(git);
    expect(review.items[0].file.patch).toContain('+line 11');
    expect(carried).toEqual([]);
  });

  it('a mode change that was not in the viewed diff is not carried', async () => {
    const git = repo({ start: lines(30), mid: lines(30, { 10: 'NEW 10' }), midMode: '755', result: lines(30, { 10: 'NEW 10', 11: 'NEW 11', 20: 'NEW 20' }) });
    const { review, carried } = await open(git);
    expect([review.items[0].file.oldMode, review.items[0].file.mode]).toEqual(['100755', '100644']);
    expect(carried).toEqual([]);
  });
});
