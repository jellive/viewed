const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 공개 전 스캔: 비공개 이름은 대소문자 무시, 일반 패턴은 구분, push 훅은 나가는 커밋만 본다.
// 임시 레포에서만 돈다. 소스에 금지 경로를 그대로 쓰면 이 레포 스캔에 걸리니 쪼개 둔다
const ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'prepublish-scan.sh');
const HOOKS = path.join(ROOT, 'scripts', 'hooks');
const NAME = 'Secretco';
const UPPER_PATH = '/Use' + 'rs/x';
const LOWER_PATH = '/use' + 'rs/foo';

// 시험이 만든 임시 폴더는 끝나면 지운다
const made = [];
const tmp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
};
test.after(() => { for (const p of made) fs.rmSync(p, { recursive: true, force: true }); });

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function repo({ list = NAME } = {}) {
  const dir = tmp('viewed-scan-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@example.com');
  if (list !== null) fs.writeFileSync(path.join(dir, '.prepublish-extra'), list);
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.prepublish-extra\n');
  return dir;
}
const commit = (dir, msg, files = { 'a.txt': `${Math.random()}\n` }) => {
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  git(dir, 'add', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', msg);
};
const scan = (dir, args = [], env = {}) => spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });

test('추적 파일의 비공개 이름은 대소문자와 상관없이 잡힌다', () => {
  const dir = repo();
  commit(dir, 'init', { 'a.txt': 'hello SECRETCO\n' });
  assert.equal(scan(dir).status, 1);
});

test('일반 패턴은 대소문자를 구분한다', () => {
  const dir = repo();
  commit(dir, 'init', { 'a.txt': `see ${LOWER_PATH}\n` });
  assert.equal(scan(dir).status, 0);
  commit(dir, 'two', { 'b.txt': `see ${UPPER_PATH}\n` });
  assert.equal(scan(dir).status, 1);
});

test('커밋 메시지의 이름은 기본 모드가 못 보고 --history 와 --revs 가 잡는다', () => {
  const dir = repo();
  commit(dir, 'secretco 관련');
  assert.equal(scan(dir).status, 0);
  assert.equal(scan(dir, ['--history']).status, 1);
  assert.equal(scan(dir, ['--revs', 'HEAD']).status, 1);
});

test('파일 이름에만 있는 이름도 --revs 가 잡는다', () => {
  const dir = repo();
  commit(dir, 'init', { 'secretco-notes.txt': 'x\n' });
  assert.equal(scan(dir, ['--revs', 'HEAD']).status, 1);
});

test('앞선 커밋의 이름은 범위 밖이면 새 push 를 막지 않는다', () => {
  const dir = repo();
  commit(dir, 'secretco');
  commit(dir, 'clean');
  assert.equal(scan(dir, ['--revs', 'HEAD', '^HEAD~1']).status, 0);
  assert.equal(scan(dir, ['--history']).status, 1);
});

test('목록이 없으면 기본 모드는 통과, --require-list 는 막는다', () => {
  const none = repo({ list: null });
  commit(none, 'init');
  assert.equal(scan(none).status, 0);
  assert.equal(scan(none, ['--require-list', '--revs', 'HEAD']).status, 2);
  const commentOnly = repo({ list: '# 주석뿐\n\n' });
  commit(commentOnly, 'init');
  assert.equal(scan(commentOnly, ['--require-list', '--revs', 'HEAD']).status, 2);
});

test('연결 워크트리도 메인 체크아웃의 목록을 쓴다', () => {
  const dir = repo();
  commit(dir, 'init');
  const wt = path.join(dir, '..', path.basename(dir) + '-wt');
  made.push(wt);
  git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  commit(wt, 'in worktree', { 'c.txt': 'secretco\n' });
  assert.equal(scan(wt).status, 1);
});

test('인자 없는 --revs 는 스캔 오류다', () => {
  const dir = repo();
  commit(dir, 'init');
  assert.equal(scan(dir, ['--revs']).status, 2);
});

// 실제 push: 훅은 core.hooksPath 로 켠다
function pushSetup() {
  const dir = repo();
  const bare = tmp('viewed-bare-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', bare);
  const push = (...args) => spawnSync('git', ['-c', `core.hooksPath=${HOOKS}`, 'push', 'origin', ...args], { cwd: dir, encoding: 'utf8' });
  const arrived = () => spawnSync('git', ['-C', bare, 'rev-parse', '--verify', '-q', 'refs/heads/main'], { encoding: 'utf8' });
  return { dir, bare, push, arrived };
}

test('push: 메시지에 이름이 든 커밋은 도착하지 않는다', () => {
  const { dir, push, arrived } = pushSetup();
  commit(dir, 'secretco');
  assert.notEqual(push('main').status, 0);
  assert.notEqual(arrived().status, 0);
});

test('push: 깨끗한 커밋은 도착한다', () => {
  const { dir, push, arrived } = pushSetup();
  commit(dir, 'clean');
  assert.equal(push('main').status, 0);
  assert.equal(arrived().status, 0);
});

test('push: 올라간 뒤 이름이 든 새 커밋은 막히고 원격은 그대로다', () => {
  const { dir, bare, push } = pushSetup();
  commit(dir, 'clean');
  assert.equal(push('main').status, 0);
  const before = git(bare, 'rev-parse', 'refs/heads/main');
  commit(dir, 'secretco');
  assert.notEqual(push('main').status, 0);
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), before);
});

test('push: 목록이 없으면 깨끗한 커밋도 막힌다', () => {
  const { dir, push, arrived } = pushSetup();
  fs.rmSync(path.join(dir, '.prepublish-extra'));
  commit(dir, 'clean');
  assert.notEqual(push('main').status, 0);
  assert.notEqual(arrived().status, 0);
});

test('push: 원격 브랜치 지우기는 검사할 것이 없어 통과한다', () => {
  const { dir, bare, push, arrived } = pushSetup();
  git(bare, 'config', 'receive.denyDeleteCurrent', 'false');   // 임시 bare 의 기본 브랜치도 지울 수 있게(git 자체 거부와 훅을 구분)
  commit(dir, 'clean');
  assert.equal(push('main').status, 0);
  assert.equal(push(':main').status, 0);
  assert.notEqual(arrived().status, 0);
});

test('push: 이미 공개된 이력의 이름은 새 push(기존·새 브랜치)를 막지 않는다', () => {
  const { dir, bare, push } = pushSetup();
  const has = (ref) => spawnSync('git', ['-C', bare, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8' }).status === 0;
  commit(dir, 'secretco');
  git(dir, 'push', 'origin', 'main');   // 훅 없이 올린다: 이미 공개된 이력을 흉내 낸다
  commit(dir, 'clean');
  assert.equal(push('main').status, 0);   // 원격 커밋이 로컬에 있다: ^rsha 경로
  git(dir, 'switch', '-q', '-c', 'side');
  commit(dir, 'clean on side');
  assert.equal(push('side').status, 0);   // 새 브랜치: --not --remotes 경로
  assert.ok(has('refs/heads/side'));
  git(dir, 'switch', '-q', '-c', 'side2', 'main');
  commit(dir, 'secretco on side2');
  assert.notEqual(push('side2').status, 0);
  assert.ok(!has('refs/heads/side2'));
});

test('rg 설정 파일(--fixed-strings)이 있어도 이름이 잡힌다', () => {
  const dir = repo();
  commit(dir, 'init', { 'a.txt': 'hello SECRETCO\n' });
  const cfg = path.join(tmp('viewed-scan-cfg-'), 'rgrc');
  fs.writeFileSync(cfg, '--fixed-strings\n');
  const env = { RIPGREP_CONFIG_PATH: cfg };
  assert.equal(scan(dir, [], env).status, 1);
  assert.equal(scan(dir, ['--revs', 'HEAD'], env).status, 1);
});

test('CRLF 목록도 이름이 잡힌다', () => {
  const dir = repo({ list: `${NAME}\r\n` });
  commit(dir, 'init', { 'a.txt': 'hello SECRETCO\n' });
  assert.equal(scan(dir).status, 1);
});

test('--text: 문자열에 이름이 있으면 1, 없으면 0, 인자 없으면 2', () => {
  const dir = repo();
  commit(dir, 'init');
  assert.equal(scan(dir, ['--text', 'refs/heads/clean']).status, 0);
  const r = scan(dir, ['--text', 'refs/heads/ok', 'refs/heads/secretco-x']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ref 이름에 공개 금지 패턴/);
  assert.equal(scan(dir, ['--text']).status, 2);
});

test('push: 공개 금지 이름이 든 ref 이름(브랜치·태그)은 막고 깨끗한 새 브랜치는 통과', () => {
  const { dir, bare, push } = pushSetup();
  const has = (ref) => spawnSync('git', ['-C', bare, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8' }).status === 0;
  commit(dir, 'clean');
  assert.notEqual(push('HEAD:refs/heads/secretco-x').status, 0);
  assert.ok(!has('refs/heads/secretco-x'));
  git(dir, 'tag', 'secretco-1');
  assert.notEqual(push('secretco-1').status, 0);
  assert.ok(!has('refs/tags/secretco-1'));
  assert.equal(push('HEAD:refs/heads/feature').status, 0);
  assert.ok(has('refs/heads/feature'));
});

test('push: 다른 비공개 remote 에서 받은 커밋도 첫 공개 push 에서 검사한다', () => {
  const { dir, bare, push } = pushSetup();
  const priv = tmp('viewed-bare-');
  git(priv, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'private', priv);
  commit(dir, 'secretco');
  git(dir, 'push', 'private', 'main');   // 훅 없이
  git(dir, 'fetch', '-q', 'private');
  assert.notEqual(push('main').status, 0);
  assert.notEqual(spawnSync('git', ['-C', bare, 'rev-parse', '--verify', '-q', 'refs/heads/main']).status, 0);
});

test('push: 다른 공개 브랜치에 이미 있는 커밋을 머지한 push 는 막히지 않는다', () => {
  const { dir, push } = pushSetup();
  commit(dir, 'clean');
  assert.equal(push('main').status, 0);
  git(dir, 'switch', '-q', '-c', 'legacy');
  commit(dir, 'secretco', { 'legacy.txt': 'l\n' });
  git(dir, 'push', 'origin', 'legacy');   // 훅 없이: 이미 공개된 이력
  git(dir, 'switch', '-q', 'main');
  commit(dir, 'clean2', { 'main2.txt': 'm\n' });
  git(dir, 'merge', '-q', '--no-ff', 'legacy', '-m', 'clean');
  assert.equal(push('main').status, 0);
});
