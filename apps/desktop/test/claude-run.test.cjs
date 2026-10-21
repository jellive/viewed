const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../ask/claude-run.cjs');

const tmps = [];
const mkdir = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmps.push(d); return d; };
const pidsToReap = new Set();
test.after(() => {
  for (const p of pidsToReap) { try { process.kill(p, 'SIGKILL'); } catch { /* 이미 없다 */ } }
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

// 임시 HOME 의 .local/bin/claude 에 가짜 claude(sh 스크립트)를 쓴다. 실제 claude 는 부르지 않는다
function fake(body, rel = ['.local', 'bin', 'claude']) {
  const home = mkdir('viewed-claude-home-');
  const bin = path.join(home, ...rel);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return { home, bin, rec: mkdir('viewed-claude-rec-') };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = (f) => { try { return Number(fs.readFileSync(f, 'utf8').trim()) || null; } catch { return null; } };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return fn(); };
const base = (f, extra = {}) => ({ bin: f.bin, args: ['x'], stdin: '', timeoutMs: 10000, signal: new AbortController().signal, env: { PATH: process.env.PATH, REC: f.rec }, ...extra });

test('findClaude follows the fixed order and refuses a binary inside the repo', async () => {
  const f = fake('exit 0');
  assert.equal(await C.findClaude(f.home, []), f.bin);
  // 두 번째 후보도 만들어 순서를 본다
  const second = path.join(f.home, '.claude', 'local', 'claude');
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(second, '#!/bin/sh\nexit 0\n'); fs.chmodSync(second, 0o755);
  assert.equal(await C.findClaude(f.home, []), f.bin);
  // 첫 후보가 레포 안을 가리키는 심볼릭 링크면 건너뛰고 두 번째로
  const repo = mkdir('viewed-claude-repo-');
  const evil = path.join(repo, 'claude'); fs.writeFileSync(evil, '#!/bin/sh\nexit 0\n'); fs.chmodSync(evil, 0o755);
  fs.rmSync(f.bin); fs.symlinkSync(evil, f.bin);
  assert.equal(await C.findClaude(f.home, [repo]), second);
  // 실행 권한이 없으면 건너뛴다
  fs.chmodSync(second, 0o644);
  const got = await C.findClaude(f.home, [repo]);
  assert.notEqual(got, second); assert.notEqual(got, f.bin);
});

test('versionAtLeast compares numerically', () => {
  const min = '2.1.248';
  assert.equal(C.MIN_VERSION, min);
  assert.equal(C.versionAtLeast('2.1.247', min), false);
  assert.equal(C.versionAtLeast('2.1.248', min), true);
  assert.equal(C.versionAtLeast('2.1.305', min), true);
  assert.equal(C.versionAtLeast('2.2.0', min), true);
  assert.equal(C.versionAtLeast('10.0.0', min), true);
  assert.equal(C.versionAtLeast('abc', min), false);
  assert.equal(C.versionAtLeast(null, min), false);
});

test('claudeVersion takes the first x.y.z of --version output', async () => {
  const f = fake('echo "2.1.300 (Claude Code)"');
  assert.equal(await C.claudeVersion(f.bin), '2.1.300');
  const g = fake('echo nothing');
  assert.equal(await C.claudeVersion(g.bin), null);
});

test('buildArgs is exactly the fixed array and never has --bare', () => {
  const a = C.buildArgs('I', 'S');
  assert.deepEqual(a, ['-p', 'I', '--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--output-format', 'json', '--no-session-persistence', '--max-turns', '2', '--append-system-prompt', 'S']);
  assert.ok(!a.includes('--bare'));
});

test('runClaude passes the exact args, feeds stdin, runs in an empty temp dir and removes it', async () => {
  const f = fake('printf \'%s\\0\' "$@" > "$REC/argv"; cat > "$REC/stdin"; pwd -P > "$REC/pwd"; ls -A | wc -l > "$REC/count"; echo \'{"result":"ok"}\'');
  const args = C.buildArgs('지시 I', '규칙 S\n두 줄');
  const r = await C.runClaude(base(f, { args, stdin: '자료\n본문' }));
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), '{"result":"ok"}');
  const argv = fs.readFileSync(path.join(f.rec, 'argv'), 'utf8').split('\0'); argv.pop();
  assert.deepEqual(argv, args);
  assert.equal(fs.readFileSync(path.join(f.rec, 'stdin'), 'utf8'), '자료\n본문');
  assert.equal(Number(fs.readFileSync(path.join(f.rec, 'count'), 'utf8').trim()), 0);
  const cwd = fs.readFileSync(path.join(f.rec, 'pwd'), 'utf8').trim();
  assert.ok(path.isAbsolute(cwd) && !fs.existsSync(cwd), 'cwd removed after close');
});

test('runClaude reports spawn failure', async () => {
  const f = fake('exit 0');
  const r = await C.runClaude(base(f, { bin: path.join(f.home, 'nope') }));
  assert.deepEqual([r.ok, r.error], [false, 'spawn']);
});

test('cleanEnv drops GIT_DIR and ELECTRON_RUN_AS_NODE and keeps HOME', () => {
  const e = C.cleanEnv({ GIT_DIR: '/x', GIT_INDEX_FILE: 'i', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', DYLD_INSERT_LIBRARIES: 'l', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', PATH: '/p', U: undefined });
  assert.deepEqual(e, { HOME: '/h', CLAUDE_CONFIG_DIR: '/c', PATH: '/p' });
});

const SLEEPER = 'sleep 30 &\necho $! > "$REC/child"\necho $$ > "$REC/self"\nsleep 30';
const reap = (f) => { for (const n of ['child', 'self']) { const p = readPid(path.join(f.rec, n)); if (p) pidsToReap.add(p); } };

test('a timeout kills claude and its child', async () => {
  const f = fake(SLEEPER);
  const t0 = Date.now();
  try {
    const r = await C.runClaude(base(f, { timeoutMs: 600 }));
    assert.deepEqual([r.ok, r.error], [false, 'timeout']);
    assert.ok(Date.now() - t0 < 600 + 2500);
    for (const n of ['child', 'self']) {
      const p = readPid(path.join(f.rec, n));
      assert.ok(p, `${n} pid recorded`);
      assert.equal(await until(() => !alive(p), 300), true, `${n} dead`);
    }
  } finally { reap(f); }
});

test('aborting cancels and kills the group', async () => {
  const f = fake(SLEEPER);
  const ac = new AbortController();
  try {
    const p = C.runClaude(base(f, { signal: ac.signal, timeoutMs: 20000 }));
    assert.equal(await until(() => readPid(path.join(f.rec, 'child')) && readPid(path.join(f.rec, 'self')), 5000) !== false, true);
    ac.abort();
    const r = await p;
    assert.deepEqual([r.ok, r.error], [false, 'cancelled']);
    for (const n of ['child', 'self']) {
      const pid = readPid(path.join(f.rec, n));
      assert.equal(await until(() => !alive(pid), 300), true, `${n} dead`);
    }
  } finally { reap(f); }
});

test('an already-aborted signal never spawns', async () => {
  const f = fake('touch "$REC/ran"');
  const ac = new AbortController(); ac.abort();
  const r = await C.runClaude(base(f, { signal: ac.signal }));
  assert.deepEqual([r.ok, r.error], [false, 'cancelled']);
  assert.equal(fs.existsSync(path.join(f.rec, 'ran')), false);
});

test('stdout over 1MB gives too-big', async () => {
  const f = fake('head -c 1200000 /dev/zero | tr "\\0" a');
  const r = await C.runClaude(base(f));
  assert.deepEqual([r.ok, r.error], [false, 'too-big']);
});

test('stderr over 64KB gives too-big', async () => {
  const f = fake('head -c 100000 /dev/zero | tr "\\0" e >&2');
  const r = await C.runClaude(base(f));
  assert.deepEqual([r.ok, r.error], [false, 'too-big']);
});

test('readResult maps is_error, empty and login text', () => {
  const j = (o) => JSON.stringify(o);
  assert.deepEqual(C.readResult(j({ is_error: false, result: '답이에요' }), ''), { ok: true, answer: '답이에요' });
  assert.equal(C.readResult('not json', '').error, 'failed');
  assert.equal(C.readResult(j({ is_error: true, result: 'boom' }), '').error, 'failed');
  assert.equal(C.readResult(j({ is_error: false, result: '' }), '').error, 'failed');
  assert.equal(C.readResult(j({ is_error: false }), '').error, 'failed');
  assert.equal(C.readResult(j({ is_error: true, result: 'Not logged in · Please run /login' }), '').error, 'login');
  assert.equal(C.readResult(j({ is_error: true, result: 'API Error: 401 Unauthorized' }), '').error, 'login');
  assert.equal(C.readResult('', 'Error: authentication failed').error, 'login');
  assert.match(C.readResult('', 'Please log in').message, /로그인/);
  assert.match(C.readResult('x', '').message, /못 받았/);
  // 성공 답 안의 "401" 은 로그인 문제가 아니다
  assert.equal(C.readResult(j({ is_error: false, result: 'HTTP 401 을 돌려줘요' }), '').ok, true);
});

test('accountEmail prefers CLAUDE_CONFIG_DIR and returns null when unreadable', () => {
  const home = mkdir('viewed-acct-home-'); const cfg = mkdir('viewed-acct-cfg-');
  const put = (d, email) => fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  put(home, 'home@example.com');
  assert.equal(C.accountEmail({}, home), 'home@example.com');
  assert.equal(C.accountEmail({ CLAUDE_CONFIG_DIR: '' }, home), 'home@example.com', 'empty counts as unset');
  put(cfg, 'you@example.com');
  assert.equal(C.accountEmail({ CLAUDE_CONFIG_DIR: cfg }, home), 'you@example.com');
  fs.writeFileSync(path.join(cfg, '.claude.json'), '{broken');
  assert.equal(C.accountEmail({ CLAUDE_CONFIG_DIR: cfg }, home), null, 'no fallback to home when cfg is set');
  assert.equal(C.accountEmail({}, mkdir('viewed-acct-empty-')), null);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 5 } }));
  assert.equal(C.accountEmail({}, home), null);
});

// ---- fix round 1 ----
const TERM_DEAF = '( trap \'\' TERM; exec sleep 30 ) </dev/null >/dev/null 2>&1 &\necho $! > "$REC/child"\nsleep 30';

test('a group member that ignores SIGTERM is SIGKILLed before runClaude resolves', async () => {
  const f = fake(TERM_DEAF);
  try {
    const r = await C.runClaude(base(f, { timeoutMs: 500 }));
    assert.deepEqual([r.ok, r.error], [false, 'timeout']);
    const p = readPid(path.join(f.rec, 'child'));
    assert.ok(p, 'child pid recorded');
    assert.equal(await until(() => !alive(p), 200), true, 'term-deaf child dead at resolve');
  } finally { reap(f); }
});

test('claudeVersion has a group deadline: a SIGTERM-ignoring binary gives null in time and is gone', async () => {
  const f = fake('echo $$ > "$REC/self"\ntrap \'\' TERM\nwhile :; do sleep 1; done');
  const env0 = process.env.REC; process.env.REC = f.rec;
  const t0 = Date.now();
  try {
    assert.equal(await C.claudeVersion(f.bin, 300), null);
    assert.ok(Date.now() - t0 < 300 + 2500);
    const p = readPid(path.join(f.rec, 'self'));
    assert.ok(p);
    assert.equal(await until(() => !alive(p), 200), true, 'version process gone');
  } finally { reap(f); if (env0 === undefined) delete process.env.REC; else process.env.REC = env0; }
});

test('claudeVersion aborts promptly when its signal fires, killing the version process', async () => {
  const f = fake('echo $$ > "$REC/self"\nsleep 30');
  const env0 = process.env.REC; process.env.REC = f.rec;
  const ac = new AbortController();
  try {
    const p = C.claudeVersion(f.bin, 5000, ac.signal);
    assert.equal(await until(() => readPid(path.join(f.rec, 'self')), 3000), true);
    const pid = readPid(path.join(f.rec, 'self'));
    const t0 = Date.now();
    ac.abort();
    assert.equal(await p, null);
    assert.ok(Date.now() - t0 < 2500, 'resolved long before the 5 s version timeout');
    assert.equal(await until(() => !alive(pid), 500), true, 'version process gone');
  } finally { reap(f); if (env0 === undefined) delete process.env.REC; else process.env.REC = env0; }
});

test('readResult does not take substrings for login problems', () => {
  assert.equal(C.readResult('', 'upstream timeout after 4010ms').error, 'failed');
  assert.equal(C.readResult('{"is_error":true,"result":"catalog index is corrupt"}', '').error, 'failed');
  assert.equal(C.readResult('{"is_error":true,"result":"dialog error"}', '').error, 'failed');
  for (const s of ['Not logged in · Please run /login', 'Please run /login', 'Invalid API key', 'authentication failed', 'Authentication required', 'API Error: 401 Unauthorized']) {
    assert.equal(C.readResult('', s).error, 'login', s);
  }
});

test('runClaude defaults env to cleanEnv(process.env)', async () => {
  const f = fake('echo "GD=${GIT_DIR-unset} H=${HOME-unset}"');
  const prev = process.env.GIT_DIR; process.env.GIT_DIR = '/nope';
  try {
    const r = await C.runClaude({ bin: f.bin, args: [], stdin: '', signal: new AbortController().signal, timeoutMs: 10000 });
    assert.equal(r.ok, true);
    assert.match(r.stdout, /GD=unset/);
    assert.doesNotMatch(r.stdout, /H=unset/);
  } finally { if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev; }
});

test('a missing or non-positive timeoutMs means the deadline is gone: timeout without spawning', async () => {
  const f = fake('touch "$REC/ran"');
  for (const t of [undefined, NaN, 0, -1]) {
    const r = await C.runClaude({ ...base(f), timeoutMs: t });
    assert.deepEqual([r.ok, r.error], [false, 'timeout'], `timeoutMs=${t}`);
  }
  assert.equal(fs.existsSync(path.join(f.rec, 'ran')), false);
});

test('runClaude always turns claude.ai connectors off, overriding the caller and covering --version', async () => {
  const f = fake('echo "C=${ENABLE_CLAUDEAI_MCP_SERVERS-unset}" > "$REC/env"\n[ "$1" = "--version" ] && echo "2.1.305 (Claude Code)"\nexit 0');
  const rec = () => fs.readFileSync(path.join(f.rec, 'env'), 'utf8').trim();
  const r = await C.runClaude(base(f, { env: { PATH: process.env.PATH, REC: f.rec, ENABLE_CLAUDEAI_MCP_SERVERS: 'true' } }));
  assert.equal(r.ok, true);
  assert.equal(rec(), 'C=false');
  fs.rmSync(path.join(f.rec, 'env'));
  const prev = process.env.ENABLE_CLAUDEAI_MCP_SERVERS; process.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'true';
  process.env.REC = f.rec;
  try {
    assert.equal(await C.claudeVersion(f.bin, 5000), '2.1.305');
    assert.equal(rec(), 'C=false');
    fs.rmSync(path.join(f.rec, 'env'));
    await C.runClaude({ bin: f.bin, args: [], stdin: '', signal: new AbortController().signal, timeoutMs: 10000 });
    assert.equal(rec(), 'C=false');
  } finally {
    delete process.env.REC;
    if (prev === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS; else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = prev;
  }
});
