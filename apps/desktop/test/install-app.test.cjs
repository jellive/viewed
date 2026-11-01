const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 설치 스크립트: 어느 단계든 실패하면 쓰던 앱을 그대로 둔다. pgrep·osascript·open 은 가짜 — 진짜 앱을 끄거나 열지 않는다
const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'install-app.sh');
const macOnly = { skip: process.platform === 'darwin' ? false : 'needs ditto' };

function setup({ running = 'no', source = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'viewed-install-')));
  const app = (root, body) => {
    fs.mkdirSync(path.join(root, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Contents', 'MacOS', 'viewed'), body, { mode: 0o755 });
  };
  const src = path.join(dir, 'out', 'viewed.app'), install = path.join(dir, 'Applications'), bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  if (source) app(src, 'new\n');
  fs.mkdirSync(install);
  app(path.join(install, 'viewed.app'), 'old\n');
  fs.writeFileSync(path.join(install, 'viewed.app', 'stale-file'), 'left over from the old version\n');
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  // running: 'no' 안 돈다 / 'yes' 끝까지 안 꺼진다 / 'quits' osascript 를 받으면 꺼진다
  const up = path.join(dir, 'up');
  if (running !== 'no') fs.writeFileSync(up, '');
  stub('pgrep', `[ -e "${up}" ]`);
  stub('osascript', running === 'quits' ? `rm -f "${up}"` : '');
  stub('open', '');
  return { dir, src, install, log, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIEWED_APP_SRC: src, VIEWED_INSTALL_DIR: install, VIEWED_QUIT_WAIT: '1' } };
}
const run = (s, ...args) => spawnSync('bash', [SCRIPT, '--skip-package', ...args], { env: s.env, encoding: 'utf8' });
const body = (s) => fs.readFileSync(path.join(s.install, 'viewed.app', 'Contents', 'MacOS', 'viewed'), 'utf8');
const calls = (s) => (fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8') : '');
const entries = (s) => fs.readdirSync(s.install);

test('replaces the installed app whole, leaves nothing behind, and opens it', macOnly, () => {
  const s = setup();
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(body(s), 'new\n');
  assert.equal(fs.existsSync(path.join(s.install, 'viewed.app', 'stale-file')), false);   // 옛 파일이 섞이지 않는다
  assert.deepEqual(entries(s), ['viewed.app']);
  assert.match(calls(s), new RegExp(`open ${s.install}/viewed\\.app`));
  assert.doesNotMatch(calls(s), /osascript/);   // 안 돌고 있으면 끄지 않는다
});

test('installs where nothing was installed before', macOnly, () => {
  const s = setup();
  fs.rmSync(path.join(s.install, 'viewed.app'), { recursive: true });
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(body(s), 'new\n');
});

test('--no-open installs without opening', macOnly, () => {
  const s = setup();
  assert.equal(run(s, '--no-open').status, 0);
  assert.equal(body(s), 'new\n');
  assert.doesNotMatch(calls(s), /open /);
});

test('quits the running app first and waits for it', macOnly, () => {
  const s = setup({ running: 'quits' });
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(body(s), 'new\n');
  const log = calls(s);
  assert.ok(log.indexOf('osascript') < log.indexOf('open '));
});

test('an app that will not quit is left as it was, and nothing is opened', macOnly, () => {
  const s = setup({ running: 'yes' });
  const r = run(s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not quit/);
  assert.equal(body(s), 'old\n');
  assert.deepEqual(entries(s), ['viewed.app']);   // 옆에 복사해 둔 것도 치운다
  assert.doesNotMatch(calls(s), /open /);
});

test('no packaged app means the installed one stays and the running one is not touched', macOnly, () => {
  const s = setup({ running: 'quits', source: false });
  const r = run(s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no packaged app/);
  assert.equal(body(s), 'old\n');
  assert.doesNotMatch(calls(s), /osascript/);
});

test('a failed copy leaves the running app alone', macOnly, () => {
  const s = setup({ running: 'quits' });
  fs.writeFileSync(path.join(s.env.PATH.split(':')[0], 'ditto'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  const r = run(s);
  assert.notEqual(r.status, 0);
  assert.equal(body(s), 'old\n');
  assert.doesNotMatch(calls(s), /osascript/);
});

test('an unknown option stops before anything happens', macOnly, () => {
  const s = setup({ running: 'quits' });
  const r = spawnSync('bash', [SCRIPT, '--nope'], { env: s.env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(body(s), 'old\n');
  assert.equal(calls(s), '');
});
