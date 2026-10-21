const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

// Claude Code CLI 를 도구 없이·빈 임시 폴더에서 돌린다(spec §7). electron 에 의존하지 않는다 — 단위 테스트가 그대로 돌린다.
// 원칙: 플래그를 빼고 돌리는 대체 경로는 없다. `--bare` 는 OAuth·키체인을 안 읽어 구독 로그인이 사라지므로 쓰지 않는다.

const MIN_VERSION = '2.1.248'; // --restricted 가 이 버전부터다
const STDOUT_MAX = 1024 * 1024;
const STDERR_MAX = 64 * 1024;
const KILL_GRACE_MS = 2000;
const VERSION_TIMEOUT_MS = 10000;

const LOGIN_RE = /not logged in|log ?in|authenticat|401/i;
const MSG_LOGIN = 'Claude Code 로그인이 필요해요(터미널에서 claude 실행)';
const MSG_FAILED = '답을 못 받았어요. 다시 시도해 주세요';

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// home/.local/bin → home/.claude/local → homebrew → /usr/local 순으로 실행 가능한 첫 claude. realpath 가 repoRoots 안이면 건너뛴다
async function findClaude(home, repoRoots) {
  const cands = [];
  if (home) cands.push(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'));
  cands.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  const roots = (repoRoots || []).map((r) => real(r) || path.resolve(r));
  for (const c of cands) {
    const r = real(c);
    if (!r) continue;
    try {
      if (!fs.statSync(r).isFile()) continue;
      fs.accessSync(r, fs.constants.X_OK);
    } catch { continue; }
    if (roots.some((root) => inside(r, root))) continue;
    return c;
  }
  return null;
}

// GIT_*·ELECTRON_*·NODE_OPTIONS·DYLD_* 만 뺀다. HOME·CLAUDE_CONFIG_DIR 는 로그인에 필요하니 둔다
function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') continue;
    if (/^(GIT_|ELECTRON_|DYLD_)/.test(k) || k === 'NODE_OPTIONS') continue;
    out[k] = v;
  }
  return out;
}

function claudeVersion(bin) {
  return new Promise((resolve) => {
    try {
      execFile(bin, ['--version'], { env: cleanEnv(process.env), timeout: VERSION_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /\d+\.\d+\.\d+/.exec(String(stdout));
        resolve(m ? m[0] : null);
      });
    } catch { resolve(null); }
  });
}

const parseVer = (v) => {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
function versionAtLeast(v, min) {
  const a = parseVer(v), b = parseVer(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// 고정 배열이다. 빼거나 바꾸지 않는다
function buildArgs(instruction, systemPrompt) {
  return ['-p', instruction, '--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--output-format', 'json',
    '--no-session-persistence', '--max-turns', '2', '--append-system-prompt', systemPrompt];
}

// 셸 없이, 새 빈 임시 폴더에서, 프로세스 그룹 리더로 돌린다. 마감·취소·한도 초과면 그룹에 SIGTERM, 2초 뒤 SIGKILL.
// 종료코드는 보지 않는다 — 판정은 readResult 가 stdout JSON·stderr 로 한다. 'close' 뒤에야 cwd 를 지우고 돌려준다(슬롯 반납 시점)
function runClaude(a) {
  return new Promise((resolve) => {
    if (a.signal && a.signal.aborted) return resolve({ ok: false, error: 'cancelled' });
    let cwd;
    try { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'viewed-ask-')); } catch { return resolve({ ok: false, error: 'spawn' }); }
    let child;
    try {
      child = spawn(a.bin, a.args, { cwd, env: a.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 무시 */ } return resolve({ ok: false, error: 'spawn' }); }

    let settled = false, reason = null, outLen = 0, errLen = 0, killTimer = null;
    const out = [], err = [];
    const sig = (s) => { try { process.kill(-child.pid, s); } catch { /* 이미 없다 */ } };
    const stop = (why) => {
      if (reason) return;
      reason = why;
      sig('SIGTERM');
      killTimer = setTimeout(() => sig('SIGKILL'), KILL_GRACE_MS);
    };
    const onAbort = () => stop('cancelled');
    const deadline = setTimeout(() => stop('timeout'), a.timeoutMs);
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(killTimer);
      if (a.signal) a.signal.removeEventListener('abort', onAbort);
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 무시 */ }
      resolve(res);
    };
    if (a.signal) a.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => { outLen += d.length; if (outLen > STDOUT_MAX) stop('too-big'); else out.push(d); });
    child.stderr.on('data', (d) => { errLen += d.length; if (errLen > STDERR_MAX) stop('too-big'); else err.push(d); });
    child.stdin.on('error', () => { /* 일찍 끝난 자식 — EPIPE 는 결과에서 드러난다 */ });
    child.on('error', () => { finish({ ok: false, error: 'spawn' }); });
    child.on('close', () => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (reason) return finish({ ok: false, error: reason, stderr });
      finish({ ok: true, stdout: Buffer.concat(out).toString('utf8'), stderr });
    });
    child.stdin.end(a.stdin || '');
  });
}

// JSON 실패·is_error·빈 result 는 실패. 실패 글이 로그인 문제처럼 보이면 login
function readResult(stdout, stderr) {
  const fail = (text) => (LOGIN_RE.test(text) ? { ok: false, error: 'login', message: MSG_LOGIN } : { ok: false, error: 'failed', message: MSG_FAILED });
  let j = null;
  try { j = JSON.parse(stdout); } catch { /* 아래에서 실패 처리 */ }
  if (!j || typeof j !== 'object') return fail(`${stderr || ''}\n${stdout || ''}`);
  const result = typeof j.result === 'string' ? j.result : '';
  if (j.is_error === true || !result.trim()) return fail(`${result}\n${stderr || ''}`);
  return { ok: true, answer: result };
}

// 로그인한 계정 이메일. CLAUDE_CONFIG_DIR(비어 있지 않으면)이 있으면 거기만 본다 — 못 읽는다고 다른 계정을 보여주지 않는다
function accountEmail(env, home) {
  const cfg = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  const file = cfg ? path.join(cfg, '.claude.json') : home ? path.join(home, '.claude.json') : null;
  if (!file) return null;
  try {
    const e = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount.emailAddress;
    return typeof e === 'string' && e ? e : null;
  } catch { return null; }
}

module.exports = { MIN_VERSION, findClaude, claudeVersion, versionAtLeast, cleanEnv, buildArgs, runClaude, readResult, accountEmail };
