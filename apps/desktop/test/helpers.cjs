const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, realpathSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');

const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

// e2e/local.spec.ts 의 makeRepo 와 같은 모양: main 에 base, feat 에 푸시하지 않은 커밋
function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-repo-')));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'a\n'); writeFileSync(join(dir, 'b.ts'), 'b\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'a.ts'), 'a2\n'); writeFileSync(join(dir, 'b.ts'), 'b2\n');
  git(dir, 'commit', '-q', '-am', 'feat');
  return dir;
}

const ALICE = ['-c', 'user.name=alice', '-c', 'user.email=a@example.test'];
const CAROL = ['-c', 'user.name=carol', '-c', 'user.email=c@example.test'];
const BOB2 = ['-c', 'user.name=bobby', '-c', 'user.email=b2@example.test'];   // .mailmap 이 bob <b@example.test> 로 바꾼다

// main 에 base, feat 에서 alice(나)·bob 이 각각 커밋. 머지 충돌은 carol 이 푼다
function makeOthersRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-others-')));
  const w = (f, t) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); };
  git(dir, 'init', '-q', '-b', 'main');
  w('.mailmap', 'bob <b@example.test> <b2@example.test>\n');
  w('old.ts', 'o\n'); w('mix.ts', 'm1\nm2\n'); w('conflict.ts', 'c0\n');
  git(dir, ...ALICE, 'add', '.mailmap', 'old.ts', 'mix.ts', 'conflict.ts');
  git(dir, ...ALICE, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'bobside');
  w('conflict.ts', 'c-bob\n');
  git(dir, ...BOB2, 'commit', '-q', '-am', 'bob conflict');
  git(dir, 'checkout', '-q', '-b', 'feat', 'main');
  w('mix.ts', 'm1\nm2\na-line\n');
  git(dir, ...ALICE, 'commit', '-q', '-am', 'alice mix');
  w('mix.ts', 'm1\nm2\na-line\nb-line\n');
  git(dir, ...BOB2, 'commit', '-q', '-am', 'bob mix');
  w('old.ts', 'o2\n');
  git(dir, ...ALICE, 'commit', '-q', '-am', 'alice old');
  git(dir, ...BOB2, 'mv', 'old.ts', 'new.ts');
  git(dir, ...BOB2, 'commit', '-q', '-m', 'bob rename');
  w('b.ts', 'b\n'); w('폴더 a/파일.ts', 'k\n');
  git(dir, ...BOB2, 'add', 'b.ts', '폴더 a/파일.ts');
  git(dir, ...BOB2, 'commit', '-q', '-m', 'bob files');
  w('conflict.ts', 'c-alice\n');
  git(dir, ...ALICE, 'commit', '-q', '-am', 'alice conflict');
  try { git(dir, ...CAROL, 'merge', '--no-ff', '-m', 'merge bobside', 'bobside'); } catch { /* 충돌이 정상 */ }
  w('conflict.ts', 'c-resolved\n');
  git(dir, ...CAROL, 'add', 'conflict.ts');
  git(dir, ...CAROL, 'commit', '-q', '--no-edit');   // 이 파일을 머지 커밋으로만 닿은 사람
  return dir;
}

module.exports = { makeRepo, makeOthersRepo, git };
