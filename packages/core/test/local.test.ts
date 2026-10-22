import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalSnapshot, loadLocalRange, repoIdFromRemote, type LocalGit } from '../src/local';
import { fingerprint } from '../src/fingerprint';

// 데스크톱 main 과 같은 플래그로 진짜 git 을 부른다
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

let dir: string;
const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const write = (p: string, s: string | Buffer) => writeFileSync(join(dir, p), s);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'viewed-local-'));
  git('init', '-q', '-b', 'main');
  write('keep.ts', 'a\nb\nc\n');
  write('old.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n');
  write('gone.ts', 'bye\n');
  write('run.sh', 'echo hi\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat');
  write('keep.ts', 'a\nB\nc\ndiff --git a/x b/x\n');   // 내용에 diff 머리 같은 줄이 있어도 파일 경계로 안 읽힌다
  renameSync(join(dir, 'old.ts'), join(dir, 'new.ts'));
  write('new.ts', 'one\ntwo\nthree\nfour\nfive\nSIX\n');
  rmSync(join(dir, 'gone.ts'));
  chmodSync(join(dir, 'run.sh'), 0o755);
  write('*.ts', 'star\n');
  write('with space.ts', 'sp\n');
  write('img.bin', Buffer.from([0, 1, 2, 0, 255]));
  git('add', '-A'); git('commit', '-q', '-m', 'feat');
  git('checkout', '-q', 'main');
  write('base-only.ts', 'later\n');   // base 가 갈라진 뒤 생긴 변경은 목록에 안 나온다(three-dot)
  git('add', '-A'); git('commit', '-q', '-m', 'main moves');
});

describe('loadLocalSnapshot', () => {
  it('lists the branch changes against the merge base with GitHub-like fields', async () => {
    const s = await loadLocalSnapshot(gitFor(dir), 'github.com/acme/widget', 'refs/heads/feat', 'refs/heads/main');
    const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(['*.ts', 'gone.ts', 'img.bin', 'keep.ts', 'new.ts', 'run.sh', 'with space.ts']);
    expect(s.headSha).toBe(git('rev-parse', 'feat').trim());
    expect(s.owner).toBe('local');
    expect(s.truncated).toBe(false);
    expect(s.mergeBase).toBe(git('merge-base', 'main', 'feat').trim());

    expect(by['keep.ts'].status).toBe('modified');
    expect(by['keep.ts'].patch).toBe('@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+diff --git a/x b/x');
    expect(by['new.ts']).toMatchObject({ status: 'renamed', previousPath: 'old.ts' });
    expect(by['new.ts'].patch).toContain('+SIX');
    expect(by['gone.ts']).toMatchObject({ status: 'removed', blobSha: null });
    expect(by['gone.ts'].patch).toBe('@@ -1 +0,0 @@\n-bye');
    expect(by['run.sh']).toMatchObject({ status: 'modified', mode: '100755' });
    expect(by['run.sh'].patch).toBeUndefined();   // 권한만 바뀌었다 — 지문은 mode 로 갈린다
    expect(by['img.bin'].patch).toBeUndefined();  // 바이너리
    expect(by['*.ts'].patch).toBe('@@ -0,0 +1 @@\n+star');   // 글롭 같은 이름도 자기 내용만
    expect(by['with space.ts'].blobSha).toBe(git('rev-parse', 'feat:with space.ts').trim());
  });

  it('gives the same fingerprints for the same commits and changes only touched files after a new commit', async () => {
    const fps = async () => Object.fromEntries(await Promise.all(
      (await loadLocalSnapshot(gitFor(dir), 'r', 'refs/heads/feat', 'refs/heads/main')).files.map(async (f) => [f.path, await fingerprint(f)])));
    const a = await fps();
    expect(await fps()).toEqual(a);
    git('checkout', '-q', 'feat');
    write('keep.ts', 'a\nB\nc\nmore\n');
    git('commit', '-q', '-am', 'again');
    git('checkout', '-q', 'main');
    const b = await fps();
    expect(Object.keys(b).filter((p) => b[p] !== a[p])).toEqual(['keep.ts']);
  });

  it('rejects a mismatch between the file list and the patch sections instead of pairing them wrong', async () => {
    const g = gitFor(dir);
    await expect(loadLocalSnapshot({ ...g, patchDiff: async () => '' }, 'r', 'refs/heads/feat', 'refs/heads/main')).rejects.toThrow(/patch/i);
  });
});

describe('loadLocalRange', () => {
  it('parses an explicit range: base commit -> an intermediate commit, and intermediate -> tip', async () => {
    const d = mkdtempSync(join(tmpdir(), 'viewed-range-'));
    const gg = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    gg('init', '-q', '-b', 'main');
    writeFileSync(join(d, 'a.ts'), '1\n2\n3\n');
    writeFileSync(join(d, 'old.ts'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
    gg('add', '-A'); gg('commit', '-q', '-m', 'c0');
    const c0 = gg('rev-parse', 'HEAD').trim();
    writeFileSync(join(d, 'a.ts'), '1\nTWO\n3\n');
    writeFileSync(join(d, 'b.ts'), 'new\n');
    gg('add', '-A'); gg('commit', '-q', '-m', 'c1');
    const c1 = gg('rev-parse', 'HEAD').trim();
    renameSync(join(d, 'old.ts'), join(d, 'new.ts'));
    writeFileSync(join(d, 'new.ts'), 'one\ntwo\nthree\nfour\nfive\nSIX\n');
    rmSync(join(d, 'a.ts'));
    gg('add', '-A'); gg('commit', '-q', '-m', 'c2');
    const c2 = gg('rev-parse', 'HEAD').trim();
    const g = gitFor(d);

    const r1 = await loadLocalRange(g, c0, c1);
    expect(r1.map((f) => [f.path, f.status, f.previousPath])).toEqual([['a.ts', 'modified', undefined], ['b.ts', 'added', undefined]]);
    expect(r1[0].patch).toBe('@@ -1,3 +1,3 @@\n 1\n-2\n+TWO\n 3');
    expect(r1[0].blobSha).toBe(gg('rev-parse', `${c1}:a.ts`).trim());
    expect(r1[1].patch).toBe('@@ -0,0 +1 @@\n+new');
    expect(r1[1].blobSha).toBe(gg('rev-parse', `${c1}:b.ts`).trim());

    const r2 = await loadLocalRange(g, c1, c2);
    expect(r2.map((f) => [f.path, f.status, f.previousPath])).toEqual([['a.ts', 'removed', undefined], ['new.ts', 'renamed', 'old.ts']]);
    expect(r2[0].blobSha).toBeNull();
    expect(r2[0].patch).toBe('@@ -1,3 +0,0 @@\n-1\n-TWO\n-3');
    expect(r2[1].patch).toBe('@@ -3,4 +3,4 @@ two\n three\n four\n five\n-six\n+SIX');
    expect(r2[1].blobSha).toBe(gg('rev-parse', `${c2}:new.ts`).trim());
    rmSync(d, { recursive: true, force: true });
  });
});

describe('type changes', () => {
  it('a file that becomes a symlink is one changed entry without a diff, and the rest still pairs up', async () => {
    const d = mkdtempSync(join(tmpdir(), 'viewed-type-'));
    const g = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(d, 'link'), 'plain\n'); writeFileSync(join(d, 'z.ts'), 'z\n');
    g('add', '-A'); g('commit', '-q', '-m', 'b');
    g('checkout', '-q', '-b', 'feat');
    rmSync(join(d, 'link')); symlinkSync('z.ts', join(d, 'link')); writeFileSync(join(d, 'z.ts'), 'z2\n');
    g('add', '-A'); g('commit', '-q', '-m', 'f');
    const s = await loadLocalSnapshot(gitFor(d), 'r', 'refs/heads/feat', 'refs/heads/main');
    const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
    expect(by['link']).toMatchObject({ status: 'changed', mode: '120000' });
    expect(by['link'].patch).toBeUndefined();
    expect(by['z.ts'].patch).toBe('@@ -1 +1 @@\n-z\n+z2');
  });
});

describe('repoIdFromRemote', () => {
  it.each([
    ['git@github.com:Acme/Widget.git', 'github.com/acme/widget'],
    ['https://github.com/Acme/Widget.git', 'github.com/acme/widget'],
    ['https://github.com/acme/widget', 'github.com/acme/widget'],
    ['ssh://git@ghe.corp:2222/acme/widget.git', 'ghe.corp/acme/widget'],
    ['https://user:tok@github.com/acme/widget.git', 'github.com/acme/widget'],
  ])('%s → %s', (url, id) => expect(repoIdFromRemote(url, '/x/folder')).toBe(id));
  it('falls back to the full folder path without a remote, so two folders with one name stay apart', () => {
    expect(repoIdFromRemote(null, '/one/worker')).toBe('folder:/one/worker');
    expect(repoIdFromRemote(null, '/two/worker')).not.toBe(repoIdFromRemote(null, '/one/worker'));
  });
});
