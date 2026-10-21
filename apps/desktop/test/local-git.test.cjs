const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRepo, makeOthersRepo, git } = require('./helpers.cjs');
const { askGit, checkPath, ops, info } = require('../local-git.cjs');

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

test('repo:git exposes only the known ops', () => {
  assert.deepEqual(Object.keys(ops), ['resolve', 'mergeBase', 'rawDiff', 'patchDiff', 'blob', 'authors', 'blameAuthors']);
});

test('log.showSignature and gpg.program never run for logLine and deletingCommit', async () => {
  const d = makeRepo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'viewed-gpg-')));
  const mark = path.join(tmp, 'gpg-ran');
  const prog = path.join(tmp, 'fakegpg.sh');
  fs.writeFileSync(prog, `#!/bin/sh\ntouch '${mark}'\nexit 1\n`, { mode: 0o755 });
  const mb = rev(d, 'main');
  fs.writeFileSync(path.join(d, 'a.ts'), 'a2\nneedle\n');
  git(d, 'commit', '-q', '-am', 'signed add');
  // 서명 헤더를 손으로 끼운 커밋(서명이 유효할 필요는 없다)
  const raw = git(d, 'cat-file', 'commit', 'HEAD');
  const i = raw.indexOf('\n\n');
  const sig = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----';
  const forged = `${raw.slice(0, i)}\n${sig}${raw.slice(i)}`;
  const objFile = path.join(tmp, 'commit.txt');
  fs.writeFileSync(objFile, forged);
  const sha = git(d, 'hash-object', '-t', 'commit', '-w', objFile).trim();
  git(d, 'reset', '-q', '--hard', sha);
  git(d, 'config', 'log.showSignature', 'true');
  git(d, 'config', 'gpg.program', prog);
  git(d, 'log', '-n', '1');
  assert.ok(fs.existsSync(mark), 'control: plain git log must run gpg.program');
  fs.rmSync(mark);

  assert.match(await askGit.logLine(d, sha, 'a.ts', 2), /signed add/);
  const r = await askGit.deletingCommit(d, mb, sha, 'a.ts', 'needle');
  assert.equal(r.sha, sha);
  assert.equal(fs.existsSync(mark), false, 'gpg.program ran');
});

test('an expired or invalid deadline rejects with "deadline" and is never turned into null', async () => {
  const d = makeRepo();
  const sha = rev(d, 'HEAD');
  assert.equal(await askGit.fileAt(d, sha, 'a.ts'), 'a2\n');
  for (const bad of [0, -5, 0.4]) {
    const o = { timeoutMs: bad };
    await assert.rejects(askGit.fileAt(d, sha, 'a.ts', o), /deadline/, `fileAt ${bad}`);
    await assert.rejects(askGit.blameLine(d, sha, 'a.ts', 1, o), /deadline/, `blameLine ${bad}`);
    await assert.rejects(askGit.logLine(d, sha, 'a.ts', 1, o), /deadline/, `logLine ${bad}`);
    await assert.rejects(askGit.deletingCommit(d, sha, sha, 'a.ts', 'a', o), /deadline/, `deletingCommit ${bad}`);
    await assert.rejects(askGit.worktrees(d, o), /deadline/, `worktrees ${bad}`);
    await assert.rejects(askGit.isCommit(d, sha, o), /deadline/, `isCommit ${bad}`);
  }
  assert.equal(await askGit.isCommit(d, sha, { timeoutMs: 30_000 }), true);
});

test('deletingCommit treats the path literally, not as a pathspec', async () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, 'app/[id]'), { recursive: true });
  fs.mkdirSync(path.join(d, 'app/i'));
  fs.writeFileSync(path.join(d, 'app/[id]/page.tsx'), 'needle\n');
  fs.writeFileSync(path.join(d, 'app/i/page.tsx'), 'needle\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'add pages');
  const mb = rev(d, 'HEAD');
  fs.writeFileSync(path.join(d, 'app/i/page.tsx'), 'gone\n');
  git(d, 'commit', '-q', '-am', 'sibling drops needle');
  const head = rev(d, 'HEAD');
  assert.equal(await askGit.deletingCommit(d, mb, head, 'app/[id]/page.tsx', 'needle'), null);
  assert.equal((await askGit.deletingCommit(d, mb, head, 'app/i/page.tsx', 'needle')).sha, head);
  assert.equal(await askGit.deletingCommit(d, mb, head, ':(exclude)app/[id]/page.tsx', 'needle'), null);
  assert.equal(await askGit.deletingCommit(d, mb, head, 'app/*/page.tsx', 'needle'), null);
});

test('worktrees splits on NUL, keeps newline paths intact, and returns realpaths', async () => {
  const d = makeRepo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'viewed-wt-')));
  const odd = path.join(tmp, 'wt\nfake');
  git(d, 'worktree', 'add', '-q', '--detach', odd);
  const link = path.join(tmp, 'link');
  fs.symlinkSync(tmp, link);
  const viaLink = path.join(link, 'wt2');
  git(d, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'wt2'));
  // git 은 경로를 스스로 정규화하므로, 등록 파일을 심볼릭 링크 경로로 고쳐 realpath 단계가 보이게 한다
  fs.writeFileSync(path.join(d, '.git', 'worktrees', 'wt2', 'gitdir'), `${viaLink}/.git\n`);
  const list = await askGit.worktrees(d);
  assert.deepEqual([...list].sort(), [d, odd, path.join(tmp, 'wt2')].sort());
});

const ALICE = ['alice', 'a@example.test'];
const BOB = ['bob', 'b@example.test'];

test('authors lists non-merge authors per path and adds merge-resolution authors', async () => {
  const d = makeOthersRepo();
  const { files } = JSON.parse(await ops.authors(d, rev(d, 'main'), rev(d, 'HEAD')));
  assert.deepEqual(files['b.ts'], [BOB]);
  assert.deepEqual(files['폴더 a/파일.ts'], [BOB]);
  assert.ok(files['conflict.ts'].some(([n, e]) => n === 'carol' && e === 'c@example.test'), JSON.stringify(files['conflict.ts']));   // carol 은 머지 커밋만 만들었다
  assert.deepEqual(files['mix.ts'].slice().sort(), [ALICE, BOB]);
  assert.equal(new Set(files['mix.ts'].map((x) => x.join())).size, files['mix.ts'].length);
});

test('authors keeps the rename target path', async () => {
  const d = makeOthersRepo();
  const { files } = JSON.parse(await ops.authors(d, rev(d, 'main'), rev(d, 'HEAD')));
  assert.deepEqual(files['new.ts'], [BOB]);
});

test('authors and blameAuthors use the same mailmapped identity', async () => {
  const d = makeOthersRepo();
  const mb = rev(d, 'main'), head = rev(d, 'HEAD');
  const { files } = JSON.parse(await ops.authors(d, mb, head));
  const lines = JSON.parse(await ops.blameAuthors(d, head, 'mix.ts', mb));
  assert.deepEqual(lines[3], BOB);   // b-line 은 b2@example.test 로 커밋됐다
  assert.ok(files['mix.ts'].some(([, e]) => e === lines[3][1]));
});

test('blameAuthors returns null for boundary lines and the author for branch lines', async () => {
  const d = makeOthersRepo();
  const lines = JSON.parse(await ops.blameAuthors(d, rev(d, 'HEAD'), 'mix.ts', rev(d, 'main')));
  assert.deepEqual(lines, [null, null, ALICE, BOB]);
});

test('blameAuthors returns null for a path missing at head', async () => {
  const d = makeOthersRepo();
  assert.equal(JSON.parse(await ops.blameAuthors(d, rev(d, 'HEAD'), 'nope.ts', rev(d, 'main'))), null);
});

test('authors and blameAuthors refuse bad oids and paths', async () => {
  const d = makeOthersRepo();
  const mb = rev(d, 'main'), head = rev(d, 'HEAD');
  await assert.rejects(ops.authors(d, 'main', head), /bad object id/);
  await assert.rejects(ops.authors(d, mb, '--all'), /bad object id/);
  await assert.rejects(ops.blameAuthors(d, 'HEAD', 'mix.ts', mb), /bad object id/);
  await assert.rejects(ops.blameAuthors(d, head, 'mix.ts', 'x'), /bad object id/);
  await assert.rejects(ops.blameAuthors(d, head, '../x', mb), /bad path/);
  await assert.rejects(ops.blameAuthors(d, head, '-x', mb), /bad path/);
});

test('info returns git user name and email', async () => {
  const d = makeRepo();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'viewed-home-'));
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, G: process.env.GIT_CONFIG_GLOBAL, S: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.HOME = empty; process.env.XDG_CONFIG_HOME = empty; process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    assert.deepEqual((await info(d)).user, { name: '', email: '' });
    git(d, 'config', 'user.name', 'carol'); git(d, 'config', 'user.email', 'c@example.test');
    assert.deepEqual((await info(d)).user, { name: 'carol', email: 'c@example.test' });
  } finally {
    process.env.HOME = saved.HOME;
    for (const [k, v] of [['XDG_CONFIG_HOME', saved.XDG], ['GIT_CONFIG_NOSYSTEM', saved.S]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('authors keeps odd path names intact (prototype keys, leading newlines, control bytes)', async () => {
  const d = makeRepo();
  const mb = rev(d, 'main');
  const names = ['constructor', '__proto__', 'toString', '\na.ts', '\nb.ts', 'a\u0001b.ts', 'x\n'];
  for (const n of names) fs.writeFileSync(path.join(d, n), 'x\n');
  git(d, '-c', 'user.name=bob', '-c', 'user.email=b@example.test', 'add', '--', ...names);
  git(d, '-c', 'user.name=bob', '-c', 'user.email=b@example.test', 'commit', '-q', '-m', 'odd');
  const { files } = JSON.parse(await ops.authors(d, mb, rev(d, 'HEAD')));
  for (const n of names) assert.deepEqual(files[n], [BOB], JSON.stringify(n));
  assert.deepEqual(files['b.ts'], [['t', 't@t']]);   // makeRepo 의 feat 커밋만 — 개행 붙은 이름이 b.ts 로 깎이지 않았다
  assert.equal(files['a'], undefined);
});

const gitAs = (d, who, ...a) => git(d, '-c', `user.name=${who[0]}`, '-c', `user.email=${who[1]}`, ...a);

test('authors reports rename pairs across the range, deduped, and credits both paths', async () => {
  const d = makeRepo();
  const mb = rev(d, 'main');
  fs.writeFileSync(path.join(d, 'feature.ts'), 'f\nf2\nf3\n'); fs.writeFileSync(path.join(d, 'chain.ts'), 'c\nc2\nc3\n');
  gitAs(d, ALICE, 'add', 'feature.ts', 'chain.ts'); gitAs(d, ALICE, 'commit', '-q', '-m', 'alice creates');
  gitAs(d, ALICE, 'mv', 'chain.ts', 'chain-b.ts'); gitAs(d, ALICE, 'commit', '-q', '-m', 'alice renames');
  gitAs(d, BOB, 'mv', 'feature.ts', 'feature-renamed.ts'); gitAs(d, BOB, 'mv', 'chain-b.ts', 'chain-c.ts');
  gitAs(d, BOB, 'commit', '-q', '-m', 'bob renames');
  const { files, renames } = JSON.parse(await ops.authors(d, mb, rev(d, 'HEAD')));
  assert.deepEqual(renames.slice().sort(), [['chain-b.ts', 'chain-c.ts'], ['chain.ts', 'chain-b.ts'], ['feature.ts', 'feature-renamed.ts']]);
  assert.deepEqual(files['feature-renamed.ts'], [BOB]);
  assert.deepEqual(files['feature.ts'].slice().sort(), [ALICE, BOB]);
});

test('authors counts Co-authored-by trailers (mailmapped) as authors of that commit paths', async () => {
  const d = makeOthersRepo();
  const mb = rev(d, 'main');
  fs.writeFileSync(path.join(d, 'co.ts'), 'x\n'); fs.writeFileSync(path.join(d, 'co2.ts'), 'x\n');
  gitAs(d, BOB, 'add', 'co.ts', 'co2.ts');
  gitAs(d, BOB, 'commit', '-q', '-m', 'pair', '-m', 'Co-authored-by: alice <a@example.test>\nCo-authored-by: bobby <b2@example.test>');
  const { files } = JSON.parse(await ops.authors(d, mb, rev(d, 'HEAD')));
  assert.deepEqual(files['co.ts'].slice().sort(), [ALICE, BOB]);   // bobby <b2> 는 mailmap 으로 bob 이 돼 중복이 접힌다
  assert.deepEqual(files['co2.ts'].slice().sort(), [ALICE, BOB]);
});

test('info normalizes git user through the repo mailmap', async () => {
  const d = makeRepo();
  fs.writeFileSync(path.join(d, '.mailmap'), 'alice <a@example.test> <a2@example.test>\n');
  git(d, 'config', 'user.name', 'alice2'); git(d, 'config', 'user.email', 'a2@example.test');
  assert.deepEqual((await info(d)).user, { name: 'alice', email: 'a@example.test' });
  git(d, 'config', 'user.name', 'zed'); git(d, 'config', 'user.email', 'z@example.test');
  assert.deepEqual((await info(d)).user, { name: 'zed', email: 'z@example.test' });
});

test('co-author mailmap lookup ignores path tokens that start with C', async () => {
  const d = makeOthersRepo();
  const mb = rev(d, 'main');
  fs.writeFileSync(path.join(d, 'CONTRIBUTING.md'), 'x\n'); fs.writeFileSync(path.join(d, 'Classes.swift'), 'x\n');
  gitAs(d, BOB, 'add', 'CONTRIBUTING.md', 'Classes.swift');
  gitAs(d, BOB, 'commit', '-q', '-m', 'docs', '-m', 'Co-authored-by: bobby <b2@example.test>');
  const { files } = JSON.parse(await ops.authors(d, mb, rev(d, 'HEAD')));
  assert.deepEqual(files['CONTRIBUTING.md'], [BOB]);   // 별칭이 mailmap 으로 접혔다 = 조회가 통째로 버려지지 않았다
  assert.deepEqual(files['Classes.swift'], [BOB]);
});

test('a name-only Co-authored-by trailer is kept as [name, ""]', async () => {
  const d = makeOthersRepo();
  const mb = rev(d, 'main');
  fs.writeFileSync(path.join(d, 'solo.ts'), 'x\n');
  gitAs(d, BOB, 'add', 'solo.ts');
  gitAs(d, BOB, 'commit', '-q', '-m', 'solo', '-m', 'Co-authored-by: alice');
  const { files } = JSON.parse(await ops.authors(d, mb, rev(d, 'HEAD')));
  assert.deepEqual(files['solo.ts'].slice().sort(), [['alice', ''], BOB]);
});

test('info survives angle brackets in user.name', async () => {
  const d = makeRepo();
  git(d, 'config', 'user.name', 'Alice <work>'); git(d, 'config', 'user.email', 'a@example.test');
  assert.deepEqual((await info(d)).user, { name: 'Alice <work>', email: 'a@example.test' });
});

test('mailmap still applies to a huge co-author batch (stdin, no E2BIG)', async () => {
  const d = makeOthersRepo();
  const mb = rev(d, 'main');
  fs.writeFileSync(path.join(d, 'big.ts'), 'x\n');
  gitAs(d, BOB, 'add', 'big.ts');
  const lines = ['Co-authored-by: bobby <b2@example.test>'];
  for (let i = 0; i < 40000; i++) lines.push(`Co-authored-by: user-number-${i} <user${i}@example.test>`);
  const msg = path.join(os.tmpdir(), `viewed-msg-${process.pid}.txt`);
  fs.writeFileSync(msg, `big\n\n${lines.join('\n')}\n`);
  gitAs(d, BOB, 'commit', '-q', '-F', msg);
  const { files } = JSON.parse(await ops.authors(d, mb, rev(d, 'HEAD')));
  assert.ok(files['big.ts'].some(([n, e]) => n === 'bob' && e === 'b@example.test'));
  assert.ok(!files['big.ts'].some(([, e]) => e === 'b2@example.test'), 'alias must be folded by mailmap');
});
