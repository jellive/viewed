import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedPaths, loadLocalRange, loadLocalSnapshot, type LocalGit } from '../src/local';
import { buildReview, markRecord, movedBases } from '../src/review';
import { mergeStates } from '../src/sync';
import { branchMatches, otherBranchCarry, sameResultCarry, selectCarryBases, targetCarry } from '../src/carry';
import type { BaseMoves, ChangedFile, DeviceState, NearMatch, NewLines, Review, ViewRecord } from '../src/types';

// 사람이 안 본 변경이 숨지 않아야 한다. 실제 git 으로 useReview 와 같은 순서(base 이동 → 다른 브랜치 → 이어받기 단계)를 돈다
const S = 'secret';
const H = (b: string) => `refs/heads/${b}`;
const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `l${i + 1}`).join('\n') + '\n';

class Repo {
  dir = mkdtempSync(join(tmpdir(), 'viewed-basis-'));
  constructor() { this.g('init', '-q', '-b', 'main'); this.g('config', 'user.name', 'me'); this.g('config', 'user.email', 'me@example.test'); }
  g(...a: string[]) { return execFileSync('git', ['-C', this.dir, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }); }
  // files 내용의 커밋을 만들고 그 해시를 돌려준다. parents 없으면 첫 커밋
  commit(files: Record<string, string | Buffer>, parents: string[] = [], mode?: Record<string, string>) {
    if (parents[0]) this.g('checkout', '-q', '--detach', parents[0]);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(this.dir, p), c);
    for (const [p, m] of Object.entries(mode ?? {})) chmodSync(join(this.dir, p), m);
    this.g('add', '-A');
    this.g('commit', '-q', '--allow-empty', '-m', 'c');
    let sha = this.g('rev-parse', 'HEAD').trim();
    if (parents.length > 1) {
      const tree = this.g('rev-parse', 'HEAD^{tree}').trim();
      sha = this.g('commit-tree', tree, '-m', 'm', ...parents.flatMap((p) => ['-p', p])).trim();
    }
    return sha;
  }
  ref(name: string, sha: string) { this.g('update-ref', H(name), sha); return sha; }
}
function gitFor(dir: string): LocalGit {
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const diff = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '-M', '--no-abbrev'];
  return {
    resolve: async (ref) => g('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim(),
    mergeBase: async (a, b) => g('merge-base', a, b).trim(),
    rawDiff: async (a, b) => g(...diff, '--raw', '-z', a, b),
    patchDiff: async (a, b) => g(...diff, '-p', '-U3', '--diff-algorithm=myers', a, b),
  };
}

async function open(r: Repo, state: DeviceState, branch: string, base: string, branches: string[] = []) {
  const git = gitFor(r.dir);
  const snap = await loadLocalSnapshot(git, 'r', H(branch), H(base));
  const n = snap.mergeBase!;
  const from = new Map<string, ReadonlySet<string> | null>();
  const moves: BaseMoves = { to: n, from };
  let st = state, near: ReadonlyMap<string, NearMatch> | undefined, unseen: NewLines = new Map();
  const build = () => buildReview(snap, st, S, undefined, moves, near, unseen);
  const write = (items: Review['items'], via: 'branch' | 'target') => { st = mergeStates([st, Object.fromEntries(items.map((it) => [it.key, { ...markRecord(it, snap.headSha, true), via: it.carryVia ?? via }]))]); };
  const load = async (p: string): Promise<ChangedFile[] | null> => loadLocalRange(git, p, snap.headSha).catch(() => null);
  let rv = await build();
  for (const b of movedBases(rv)) from.set(b, await changedPaths(git, b, n));
  rv = await build();
  if (branches.length) {
    const m = await branchMatches(rv, snap, st, S, branches.map(H));
    near = m.near;
    write(m.exact, 'branch');
    rv = await build();
  }
  const prev: { base: string; files: ChangedFile[] }[] = [];
  for (const p of await selectCarryBases(rv, n, async (x) => (await git.mergeBase(n, x)) === n)) { const files = await load(p); if (files) prev.push({ base: p, files }); }
  if (prev.length) { write(await targetCarry(rv, n, prev), 'target'); rv = await build(); }
  const same = await sameResultCarry(rv, n, load);
  unseen = new Map([...unseen, ...same.lines]);
  write(same.carried, 'target');
  rv = await build();
  if (branches.length) {
    const other = await otherBranchCarry(rv, snap, st, S, branches.map(H), load);
    unseen = new Map([...unseen, ...other.lines]);
    write(other.carried, 'branch');
    rv = await build();
  }
  return { review: rv, state: st, snap };
}
const item = (o: { review: Review }, p: string) => o.review.items.find((i) => i.file.path === p)!;
const stateOf = (o: { review: Review }, p: string) => item(o, p).state;
const checkAll = (o: { review: Review; state: DeviceState; snap: { headSha: string } }): DeviceState =>
  mergeStates([o.state, Object.fromEntries(o.review.items.filter((i) => i.state !== 'viewed').map((i) => [i.key, markRecord(i, o.snap.headSha, true)]))]);
const newText = (o: { review: Review }, p: string) => { const i = item(o, p); const all = i.file.patch!.split('\n'); return (i.newLines ?? []).map((n) => all[n]); };

// n ← p(남의 변경 P30), n ← q(내 L5 를 이미 가짐), feat = merge(p, q) + L50. 사람은 p 기준 diff(L5, L50)만 봤다
function sideways() {
  const r = new Repo();
  const n = r.ref('n', r.commit({ 'a.ts': lines(80), 'w.ts': 'w0\n' }));
  const p = r.ref('p', r.commit({ 'a.ts': lines(80, { 30: 'P30' }), 'w.ts': 'not mine\n' }, [n]));
  const q = r.ref('q', r.commit({ 'a.ts': lines(80, { 5: 'L5' }), 'w.ts': 'w0\n' }, [n]));
  r.ref('feat', r.commit({ 'a.ts': lines(80, { 5: 'L5', 30: 'P30', 50: 'L50' }), 'w.ts': 'not mine\n' }, [p, q]));
  return r;
}

describe('a carried record is not what the person saw', () => {
  it('moving back to an older target and then sideways does not hide what only the older target had', async () => {
    const r = sideways();
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    expect([stateOf(atN, 'a.ts'), stateOf(atN, 'w.ts')]).toEqual(['viewed', 'viewed']);   // 여기까지는 설계대로 이어받는다
    const atQ = await open(r, atN.state, 'feat', 'q');
    expect(stateOf(atQ, 'a.ts')).toBe('changed-since-viewed');
    expect(stateOf(atQ, 'w.ts')).toBe('unread');
    // 옛 대상으로 바로 옮긴 것과 같다
    const direct = await open(r, checkAll(atP), 'feat', 'q');
    expect([stateOf(direct, 'a.ts'), stateOf(direct, 'w.ts')]).toEqual(['changed-since-viewed', 'unread']);
  });

  it('marks what only the older target had as never seen', async () => {
    const r = sideways();
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    const atQ = await open(r, atN.state, 'feat', 'q');
    expect(newText(atQ, 'a.ts')).toEqual(['-l30', '+P30']);
  });

  it('does not use it as a seen block on another branch', async () => {
    const r = sideways();
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    // 다른 브랜치: P30 과 내 L77. 겹치는 것은 사람이 본 적 없는 P30 뿐이다
    r.ref('feat2', r.commit({ 'a.ts': lines(80, { 30: 'P30', 77: 'L77' }), 'w.ts': 'w0\n' }, [r.g('rev-parse', H('n')).trim()]));
    const other = await open(r, atN.state, 'feat2', 'n', ['feat']);
    expect(stateOf(other, 'a.ts')).toBe('unread');
    expect(item(other, 'a.ts').newBlocks).toBeUndefined();
  });

  it('on another branch with the same content, compares with what the person saw', async () => {
    const r = sideways();
    const feat = r.g('rev-parse', H('feat')).trim();
    r.ref('feat2', feat);
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    const atQ = await open(r, atN.state, 'feat2', 'q', ['feat']);
    expect(stateOf(atQ, 'a.ts')).toBe('changed-since-viewed');
    expect(newText(atQ, 'a.ts')).toEqual(['-l30', '+P30']);
    expect(stateOf(atQ, 'w.ts')).toBe('unread');
  });

  it('on another branch, the very same diff on the same target carries over, and still proves nothing sideways', async () => {
    const r = sideways();
    r.ref('feat2', r.g('rev-parse', H('feat')).trim());
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    const other = await open(r, atN.state, 'feat2', 'n', ['feat']);
    expect([stateOf(other, 'a.ts'), stateOf(other, 'w.ts')]).toEqual(['viewed', 'viewed']);
    expect(item(other, 'a.ts').carriedOver).toBe(true);
    const key = item(other, 'a.ts').key, rec = other.state[key];
    expect([rec.via, rec.prev?.base]).toEqual(['target', r.g('merge-base', H('p'), H('feat')).trim()]);
    // 그 기록으로 옆 대상에 가도 사람이 본 것과만 맞댄다
    const atQ = await open(r, other.state, 'feat2', 'q');
    expect(stateOf(atQ, 'a.ts')).toBe('changed-since-viewed');
    expect(newText(atQ, 'a.ts')).toEqual(['-l30', '+P30']);
    expect(stateOf(atQ, 'w.ts')).toBe('unread');
  });

  it('on another branch, the same diff on a different target is not taken from a carried record', async () => {
    const r = new Repo();
    const b = r.commit({ 'a.ts': lines(60) });
    const p = r.ref('tp', r.commit({ 'o.ts': 'p\n' }, [b]));
    const n = r.ref('tn', r.commit({ 'a.ts': lines(60, { 2: 'T2' }), 'o.ts': 'n\n' }, [b]));
    const m = r.ref('tm', r.commit({ 'a.ts': lines(60, { 2: 'T2' }), 'o.ts': 'm\n' }, [b]));
    const f = r.ref('feat', r.commit({ 'a.ts': lines(60, { 2: 'T2', 30: 'MINE' }), 'o.ts': 'f\n' }, [p, n, m]));
    r.ref('feat2', f);
    const atP = await open(r, {}, 'feat', 'tp');
    const atN = await open(r, checkAll(atP), 'feat', 'tn');
    // tn 에서 이어받은 기록 — tm 의 diff 와 글자까지 같다
    const rec: ViewRecord = { ...markRecord(item(atN, 'a.ts'), atN.snap.headSha, true), via: 'target' };
    const faked: DeviceState = { ...atN.state, [item(atN, 'a.ts').key]: rec };
    const other = await open(r, faked, 'feat2', 'tm', ['feat']);
    expect(item(other, 'a.ts').fp).toBe(rec.fp);   // 글자까지 같은 diff 다
    expect(stateOf(other, 'a.ts')).toBe('unread');
  });

  it('a record from before this rule that points at another carried record proves nothing', async () => {
    const r = sideways();
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    const key = item(atN, 'a.ts').key, rec = atN.state[key];
    const legacy: DeviceState = { ...atN.state, [key]: { ...rec, prev: { ...rec.prev!, via: 'target' } } };
    expect(stateOf(await open(r, legacy, 'feat', 'q'), 'a.ts')).toBe('unread');
    // 대상 정보가 없는 옛 기록도 맞댈 diff 가 없다
    const noBase: DeviceState = { ...atP.state, [key]: { ...checkAll(atP)[key], base: undefined } };
    expect(item(await open(r, noBase, 'feat', 'q'), 'a.ts').newLines).toBeUndefined();
  });

  it('a check made by hand on the carried diff counts as seen from then on', async () => {
    const r = sideways();
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    const key = item(atN, 'a.ts').key;
    const byHand = mergeStates([atN.state, { [key]: { ...markRecord({ ...item(atN, 'a.ts'), carryPrev: undefined }, atN.snap.headSha, true, new Date(Date.now() + 1000)) } }]);
    expect(byHand[key].via).toBeUndefined();
    const atQ = await open(r, byHand, 'feat', 'q');
    expect(stateOf(atQ, 'a.ts')).toBe('viewed');   // n 기준 diff 를 사람이 봤으니 그 부분집합이다
  });
});

describe('going through several targets', () => {
  // m ← n ← p, feat = p + L50. 사람은 p 기준 diff(L50)만 봤다
  function chain() {
    const r = new Repo();
    const m = r.ref('m', r.commit({ 'a.ts': lines(60) }));
    const n = r.ref('n', r.commit({ 'a.ts': lines(60, { 10: 'N10' }) }, [m]));
    const p = r.ref('p', r.commit({ 'a.ts': lines(60, { 10: 'N10', 30: 'P30' }) }, [n]));
    r.ref('feat', r.commit({ 'a.ts': lines(60, { 10: 'N10', 30: 'P30', 50: 'L50' }) }, [p]));
    return r;
  }

  it('P → N → M → P still shows what the person checked, as checked by hand', async () => {
    const r = chain();
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    const atM = await open(r, atN.state, 'feat', 'm');
    expect([stateOf(atN, 'a.ts'), stateOf(atM, 'a.ts')]).toEqual(['viewed', 'viewed']);
    const back = await open(r, atM.state, 'feat', 'p');
    expect(stateOf(back, 'a.ts')).toBe('viewed');
    expect(item(back, 'a.ts').auto).toBeUndefined();
  });

  it('P → M → N stays carried, because both are behind the target that was checked', async () => {
    const r = chain();
    const atP = await open(r, {}, 'feat', 'p');
    const atM = await open(r, checkAll(atP), 'feat', 'm');
    const atN = await open(r, atM.state, 'feat', 'n');
    expect(stateOf(atN, 'a.ts')).toBe('viewed');
  });

  it('the first check survives every hop in the record', async () => {
    const r = chain();
    const atP = await open(r, {}, 'feat', 'p');
    const first = checkAll(atP);
    const key = item(atP, 'a.ts').key, base = first[key].base, fp = first[key].fp;
    const atN = await open(r, first, 'feat', 'n');
    const atM = await open(r, atN.state, 'feat', 'm');
    const rec: ViewRecord = atM.state[key];
    expect([rec.via, rec.prev?.base, rec.prev?.fp, rec.prev?.via]).toEqual(['target', base, fp, undefined]);
  });

  it('a new branch name opened on the checked target finds the diff the person saw', async () => {
    const r = chain();
    r.ref('renamed', r.g('rev-parse', H('feat')).trim());
    const atP = await open(r, {}, 'feat', 'p');
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    const other = await open(r, atN.state, 'renamed', 'p', ['feat']);
    expect(stateOf(other, 'a.ts')).toBe('viewed');
    expect(item(other, 'a.ts').carriedOver).toBe(true);
  });

  it('a mode change seen on the first target is still seen after coming back', async () => {
    const r = new Repo();
    const n = r.ref('n', r.commit({ 'a.ts': lines(30) }));
    const p = r.ref('p', r.commit({ 'a.ts': lines(30, { 10: 'P10' }) }, [n], { 'a.ts': '755' }));
    r.ref('feat', r.commit({ 'a.ts': lines(30, { 10: 'P10', 20: 'L20' }) }, [p], { 'a.ts': '644' }));
    const atP = await open(r, {}, 'feat', 'p');
    expect([item(atP, 'a.ts').file.oldMode, item(atP, 'a.ts').file.mode]).toEqual(['100755', '100644']);
    const atN = await open(r, checkAll(atP), 'feat', 'n');
    expect(stateOf(atN, 'a.ts')).toBe('viewed');
    expect(stateOf(await open(r, atN.state, 'feat', 'p'), 'a.ts')).toBe('viewed');
  });
});

describe('a mode change nobody saw', () => {
  // 대상 둘이 내용은 같고 mode 만 다르다. feat 는 644 + 내 변경
  function modes(tp: string, tn: string, head: string, tweak?: string) {
    const r = new Repo();
    const b = r.commit({ 'a.ts': lines(30), 'o.ts': 'o\n' });
    const p = r.ref('tp', r.commit({ 'o.ts': 'p\n' }, [b], { 'a.ts': tp }));
    const n = r.ref('tn', r.commit({ 'o.ts': 'n\n', ...(tweak ? { 'a.ts': lines(30, { 8: tweak }) } : {}) }, [b], { 'a.ts': tn }));
    r.ref('feat', r.commit({ 'a.ts': lines(30, { 10: 'MINE' }), 'o.ts': 'f\n' }, [p, n], { 'a.ts': head }));
    return r;
  }

  it('is changed even when the diff text is the same', async () => {
    const r = modes('644', '755', '644');
    const atP = await open(r, {}, 'feat', 'tp');
    const atN = await open(r, checkAll(atP), 'feat', 'tn');
    expect(item(atN, 'a.ts').file.patch).toBe(item(atP, 'a.ts').file.patch);
    expect(stateOf(atN, 'a.ts')).toBe('changed-since-viewed');
  });
  it('is changed when the blocks match but the neighbouring lines moved', async () => {
    const r = modes('644', '755', '644', 'TARGET8');
    const atP = await open(r, {}, 'feat', 'tp');
    expect(stateOf(await open(r, checkAll(atP), 'feat', 'tn'), 'a.ts')).toBe('changed-since-viewed');
  });
  it('is changed in the other direction too', async () => {
    const r = modes('755', '644', '755');
    const atP = await open(r, {}, 'feat', 'tp');
    expect(stateOf(await open(r, checkAll(atP), 'feat', 'tn'), 'a.ts')).toBe('changed-since-viewed');
  });
  it('is not taken from another branch as the same diff', async () => {
    const r = modes('644', '755', '644');
    r.ref('feat2', r.g('rev-parse', H('feat')).trim());
    const atP = await open(r, {}, 'feat', 'tp');
    const other = await open(r, checkAll(atP), 'feat2', 'tn', ['feat']);
    expect(stateOf(other, 'a.ts')).toBe('unread');
  });
  it('a file with the same mode change that was seen stays viewed', async () => {
    const r = modes('755', '755', '644');
    const atP = await open(r, {}, 'feat', 'tp');
    expect(stateOf(await open(r, checkAll(atP), 'feat', 'tn'), 'a.ts')).toBe('viewed');
  });
  // 이 필드 전 기록은 oldMode 를 모른다. 그때의 diff 를 다시 만들어 맞대면 본 mode 변경인지 안다
  const older = (st: DeviceState, key: string) => { const { oldMode: _gone, ...o } = st[key]; return { ...st, [key]: o as ViewRecord }; };
  it('an older record is checked against the rebuilt diff: the mode change it saw stays viewed', async () => {
    const r = modes('755', '755', '644');
    const atP = await open(r, {}, 'feat', 'tp');
    const st = checkAll(atP);
    expect(st[item(atP, 'o.ts').key].oldMode).toBe('100644');
    expect(stateOf(await open(r, older(st, item(atP, 'a.ts').key), 'feat', 'tn'), 'a.ts')).toBe('viewed');
  });
  it('an older record does not hide a mode change it did not see', async () => {
    const r = modes('644', '755', '644');
    const atP = await open(r, {}, 'feat', 'tp');
    const st = checkAll(atP);
    expect(stateOf(await open(r, older(st, item(atP, 'a.ts').key), 'feat', 'tn'), 'a.ts')).toBe('changed-since-viewed');
  });
  it('coming back to the same target never asks again: the left side is the same tree', async () => {
    const r = modes('755', '755', '644');
    const atP = await open(r, {}, 'feat', 'tp');
    const st = checkAll(atP);
    expect(stateOf(await open(r, older(st, item(atP, 'a.ts').key), 'feat', 'tp'), 'a.ts')).toBe('viewed');
  });
  // 이 필드 전 기록은 지금 쌓인 것 전부다 — mode 변경이 없는 파일이 대상을 옮길 때마다 다시 판정되면 안 된다
  it('older records of ordinary, new and removed files stay as checked when the target moves', async () => {
    const r = new Repo();
    const b = r.commit({ 'a.ts': lines(20), 'gone.ts': 'g\n', 'k.ts': 'k\n' });
    const p = r.ref('tp', r.commit({ 'k.ts': 'p\n' }, [b]));
    const n = r.ref('tn', r.commit({ 'k.ts': 'n\n' }, [b]));
    r.g('checkout', '-q', '--detach', r.commit({ 'a.ts': lines(20, { 5: 'MINE' }), 'new.ts': 'new\n', 'k.ts': 'f\n' }, [p, n]));
    r.g('rm', '-q', 'gone.ts');
    r.g('commit', '-q', '-m', 'rm');
    r.ref('feat', r.g('rev-parse', 'HEAD').trim());
    const atP = await open(r, {}, 'feat', 'tp');
    const st = Object.fromEntries(Object.entries(checkAll(atP)).map(([k, v]) => { const { oldMode: _x, ...o } = v; return [k, o as ViewRecord]; }));
    const atN = await open(r, st, 'feat', 'tn');
    for (const f of ['a.ts', 'new.ts', 'gone.ts']) {
      expect(stateOf(atN, f)).toBe('viewed');
      expect(item(atN, f).auto).toBeUndefined();   // 다시 맞대 이어받은 게 아니라 그 기록 그대로다
    }
  });

  it('new and removed files do not count as mode changes, so older records stay viewed', async () => {
    const r = new Repo();
    const b = r.ref('main2', r.commit({ 'gone.ts': 'g\n', 'k.ts': 'k\n' }));
    const r1 = r.commit({ 'new.ts': 'n\n' }, [b]);
    const f = r.commit({ 'k.ts': 'k2\n' }, [r1]);
    writeFileSync(join(r.dir, 'gone.ts'), 'g\n');
    r.g('rm', '-q', 'gone.ts');
    r.g('commit', '-q', '-m', 'rm');
    r.ref('feat', r.g('rev-parse', 'HEAD').trim());
    expect(f).toBeTruthy();
    const at = await open(r, {}, 'feat', 'main2');
    const older = Object.fromEntries(Object.entries(checkAll(at)).map(([k, v]) => { const { oldMode: _x, ...o } = v; return [k, o as ViewRecord]; }));
    r.ref('later', r.commit({ 'unrelated.ts': 'u\n' }, [b]));
    const again = await open(r, older, 'feat', 'main2');
    for (const i of again.review.items) expect(i.state).toBe('viewed');
  });
});

describe('the same text in another place, with the same neighbouring lines', () => {
  // 블록 서명은 앞뒤 한 줄까지만 본다. 두 함수의 앞뒤 줄이 같으면 맞아 버린다
  const fn = (name: string, auth: boolean) => [`function ${name}() {`, '  pre();', ...(auth ? ['  authorize();'] : []), '  run();', '}', ...Array.from({ length: 10 }, (_, i) => `// ${name} ${i}`)];
  const file = (s: boolean, p: boolean) => [...fn('sandbox', s), ...fn('production', p)].join('\n') + '\n';
  function repo() {
    const r = new Repo();
    const b = r.commit({ 'a.ts': file(true, true) });
    const p = r.ref('tp', r.commit({ 'a.ts': file(true, false) }, [b]));
    const n = r.ref('tn', r.commit({ 'a.ts': file(false, true) }, [b]));
    r.ref('feat', r.commit({ 'a.ts': file(false, false) }, [p, n]));
    return r;
  }

  it('is not hidden: the blocks match but the lines are elsewhere', async () => {
    const r = repo();
    const atP = await open(r, {}, 'feat', 'tp');
    const atN = await open(r, checkAll(atP), 'feat', 'tn');
    expect(stateOf(atN, 'a.ts')).toBe('changed-since-viewed');
    expect(newText(atN, 'a.ts')).toEqual(['-  authorize();']);
  });

  it('stays viewed once the person checks it', async () => {
    const r = repo();
    const atP = await open(r, {}, 'feat', 'tp');
    const atN = await open(r, checkAll(atP), 'feat', 'tn');
    const again = await open(r, checkAll(atN), 'feat', 'tn');
    expect(stateOf(again, 'a.ts')).toBe('viewed');
    expect(item(again, 'a.ts').newLines).toBeUndefined();
  });

  it('blocks that really are the same place stay viewed without a badge change', async () => {
    const r = new Repo();
    const b = r.commit({ 'a.ts': lines(40) });
    const p = r.ref('tp', r.commit({ 'o.ts': 'p\n' }, [b]));
    const n = r.ref('tn', r.commit({ 'a.ts': lines(40, { 2: 'T2' }), 'o.ts': 'n\n' }, [b]));
    r.ref('feat', r.commit({ 'a.ts': lines(40, { 2: 'T2', 20: 'MINE' }), 'o.ts': 'f\n' }, [p, n]));
    const atP = await open(r, {}, 'feat', 'tp');
    const atN = await open(r, checkAll(atP), 'feat', 'tn');
    expect(stateOf(atN, 'a.ts')).toBe('viewed');
    expect(item(atN, 'a.ts').auto).toBeUndefined();
  });
});

describe('bytes that do not decode', () => {
  const euc = (b: number) => Buffer.from([0xb0, b, 0x0a, 0x61, 0x0a]);
  it('a new commit changing them is not hidden by an identical-looking diff', async () => {
    const r = new Repo();
    const b = r.ref('base', r.commit({ 'a.txt': Buffer.from([0x78, 0x0a, 0x61, 0x0a]) }));
    r.ref('feat', r.commit({ 'a.txt': euc(0xa2) }, [b]));
    const first = await open(r, {}, 'feat', 'base');
    const st = checkAll(first);
    r.ref('feat', r.commit({ 'a.txt': euc(0xa3) }, [r.g('rev-parse', H('feat')).trim()]));
    const next = await open(r, st, 'feat', 'base');
    expect(item(next, 'a.txt').file.patch).toBe(item(first, 'a.txt').file.patch);
    expect(stateOf(next, 'a.txt')).toBe('changed-since-viewed');
  });
  it('are not taken from another branch on the same base', async () => {
    const r = new Repo();
    const b = r.ref('base', r.commit({ 'a.txt': Buffer.from([0x78, 0x0a, 0x61, 0x0a]) }));
    r.ref('feat', r.commit({ 'a.txt': euc(0xa2) }, [b]));
    r.ref('feat2', r.commit({ 'a.txt': euc(0xa3) }, [b]));
    const first = await open(r, {}, 'feat', 'base');
    const other = await open(r, checkAll(first), 'feat2', 'base', ['feat']);
    expect(stateOf(other, 'a.txt')).toBe('unread');   // 같은 글자라 블록도 맞지만 흐리게 그리면 본 것처럼 보인다
  });
});

it('a deleted binary with different old content on the new target is not viewed', async () => {
  const r = new Repo();
  const b = r.commit({ 'a.bin': Buffer.from([0, 1, 2, 3]), 'k.ts': 'k\n' });
  const p = r.ref('tp', r.commit({ 'k.ts': 'p\n' }, [b]));
  const n = r.ref('tn', r.commit({ 'a.bin': Buffer.from([0, 9, 9, 9]), 'k.ts': 'n\n' }, [b]));
  const merged = r.commit({ 'k.ts': 'f\n' }, [p, n]);
  r.g('checkout', '-q', '--detach', merged);
  r.g('rm', '-q', 'a.bin');
  r.g('commit', '-q', '-m', 'rm');
  r.ref('feat', r.g('rev-parse', 'HEAD').trim());
  const atP = await open(r, {}, 'feat', 'tp');
  expect(item(atP, 'a.bin').file.patch).toBeUndefined();
  expect(stateOf(await open(r, checkAll(atP), 'feat', 'tn'), 'a.bin')).toBe('changed-since-viewed');
});
