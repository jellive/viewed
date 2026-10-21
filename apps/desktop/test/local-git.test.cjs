const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRepo, git } = require('./helpers.cjs');
const { askGit, checkPath, ops } = require('../local-git.cjs');

const rev = (d, r) => git(d, 'rev-parse', r).trim();

test('blameLine and logLine start from the given commit, not HEAD', async () => {
  const d = makeRepo();
  const featSha = rev(d, 'HEAD');
  git(d, 'checkout', '-q', 'main');
  const b = await askGit.blameLine(d, featSha, 'a.ts', 1);
  assert.equal(b.sha, featSha);
  assert.equal(b.summary, 'feat');
  assert.ok(Number.isFinite(b.committerTime) && b.committerTime > 1e12);   // epoch ms
  assert.match(await askGit.logLine(d, featSha, 'a.ts', 1), /feat/);
  assert.equal(await askGit.blameLine(d, featSha, 'a.ts', 99), null);
});

test('deletingCommit finds the commit in mergeBase..head that removed the line', async () => {
  const d = makeRepo();
  const mb = rev(d, 'main');
  fs.writeFileSync(path.join(d, 'a.ts'), 'a2\nkeep\nneedle\n');
  git(d, 'commit', '-q', '-am', 'add needle');
  fs.writeFileSync(path.join(d, 'a.ts'), 'a2\nkeep\n');
  git(d, 'commit', '-q', '-am', 'drop needle');
  const dropSha = rev(d, 'HEAD');
  const r = await askGit.deletingCommit(d, mb, dropSha, 'a.ts', 'needle');
  assert.equal(r.sha, dropSha);
  assert.equal(r.summary, 'drop needle');
  assert.equal(await askGit.deletingCommit(d, mb, dropSha, 'a.ts', 'no-such-text'), null);
});

test('paths with spaces and Korean work, and bad paths are refused', async () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, 'dir'));
  fs.writeFileSync(path.join(d, 'dir', '공백 있는 파일.ts'), 'x\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'korean');
  const sha = rev(d, 'HEAD');
  assert.equal(await askGit.fileAt(d, sha, 'dir/공백 있는 파일.ts'), 'x\n');
  assert.equal((await askGit.blameLine(d, sha, 'dir/공백 있는 파일.ts', 1)).sha, sha);
  assert.equal(await askGit.fileAt(d, sha, 'nope.ts'), null);
  for (const bad of ['../x', '-x', '/a', 'a\nb', '', 'a/../b', 'a\0b']) assert.throws(() => checkPath(bad), /bad path/, JSON.stringify(bad));
  assert.equal(checkPath('dir/ok.ts'), 'dir/ok.ts');
  await assert.rejects(askGit.fileAt(d, sha, '../x'), /bad path/);
});

test('worktrees lists the repo itself, and isCommit checks the type', async () => {
  const d = makeRepo();
  const sha = rev(d, 'HEAD');
  assert.ok((await askGit.worktrees(d)).includes(d));
  assert.equal(await askGit.isCommit(d, sha), true);
  assert.equal(await askGit.isCommit(d, rev(d, 'HEAD^{tree}')), false);
  assert.equal(await askGit.isCommit(d, 'HEAD'), false);
});

test('repo textconv and external diff config never run a program', async () => {
  const d = makeRepo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'viewed-mark-')));
  const mark = path.join(tmp, 'm1'), mark2 = path.join(tmp, 'm2');
  fs.writeFileSync(path.join(d, '.gitattributes'), '* diff=evil\n');
  git(d, 'add', '.gitattributes'); git(d, 'commit', '-q', '-m', 'attrs');
  const sha = rev(d, 'HEAD');
  const mb = rev(d, 'main');
  // 대조군: 픽스처가 살아 있다면 textconv·external 이 각각 표식을 만든다(external 이 있으면 textconv 는 안 불리므로 따로)
  git(d, 'config', 'diff.evil.textconv', `sh -c 'touch ${mark}'`);
  git(d, 'log', '-p', '--textconv', '-n', '2');
  assert.ok(fs.existsSync(mark), 'control: textconv fixture must trigger');
  git(d, 'config', 'diff.external', `sh -c 'touch ${mark2}'`);
  git(d, 'log', '-p', '--ext-diff', '-n', '2');
  assert.ok(fs.existsSync(mark2), 'control: external diff fixture must trigger');
  fs.rmSync(mark); fs.rmSync(mark2);

  await askGit.worktrees(d);
  await askGit.isCommit(d, sha);
  await askGit.fileAt(d, sha, 'a.ts');
  await askGit.blameLine(d, sha, 'a.ts', 1);
  await askGit.logLine(d, sha, 'a.ts', 1);
  await askGit.deletingCommit(d, mb, sha, 'a.ts', 'a');
  assert.equal(fs.existsSync(mark), false, 'textconv ran');
  assert.equal(fs.existsSync(mark2), false, 'external diff ran');
});

test('repo:git still exposes only the old ops', () => {
  assert.deepEqual(Object.keys(ops), ['resolve', 'mergeBase', 'rawDiff', 'patchDiff', 'blob']);
});
