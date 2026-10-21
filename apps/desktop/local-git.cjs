const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// 읽기 전용 git 실행. 셸 없이, 정해진 인자만. 레포 설정이 외부 프로그램을 부르지 못하게 끈다
const BASE = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
// --submodule=short: 레포 설정의 diff.submodule=diff|log 는 하위 git 을 따로 돌리는데, 그 하위 실행엔 위 차단 옵션이 안 넘어간다
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '-M', '--no-abbrev'];
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF = /^refs\/(?:heads|remotes)\/[A-Za-z0-9._\/+-]+$/;

function env() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) e[k] = v;   // 상속된 GIT_DIR 등이 다른 레포를 가리키지 않게
  return { ...e, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
}

function git(repo, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...BASE, ...args], { env: env(), maxBuffer: 64 << 20, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

const oid = (x) => { if (typeof x !== 'string' || !OID.test(x)) throw new Error('bad object id'); return x; };
const ref = (x) => { if (typeof x !== 'string' || !REF.test(x) || x.includes('..') || x.endsWith('.lock')) throw new Error('bad ref'); return x; };

// 사용자가 대화상자로 고른 레포만 연다 — 목록은 userData/repos.json
function createRepos(userData) {
  const file = () => path.join(userData(), 'repos.json');
  async function list() {
    try { const v = JSON.parse(await fs.readFile(file(), 'utf8')); return Array.isArray(v) ? v.filter((p) => typeof p === 'string') : []; }
    catch (e) { if (e && e.code === 'ENOENT') return []; if (e instanceof SyntaxError) return []; throw e; }
  }
  async function add(dir) {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');   // trim 은 폴더 이름 끝 공백까지 지운다
    const real = await fs.realpath(top);
    const all = await list();
    if (!all.includes(real)) {
      const tmp = file() + '.tmp';
      await fs.writeFile(tmp, JSON.stringify([...all, real]), { mode: 0o600 });
      await fs.rename(tmp, file());
    }
    return real;
  }
  async function allowed(repo) {
    if (typeof repo !== 'string' || !(await list()).includes(repo)) throw new Error('repository not added');
    return repo;
  }
  return { list, add, allowed };
}

async function info(repo) {
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']))
    .split('\n').filter((r) => REF.test(r) && !r.endsWith('/HEAD'));
  const head = await git(repo, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then((s) => s.trim(), () => '');
  const remote = await git(repo, ['remote', 'get-url', 'origin']).then((s) => s.trim(), () => null);
  const current = await git(repo, ['symbolic-ref', '-q', 'HEAD']).then((s) => s.trim(), () => '');
  return { refs, defaultBase: REF.test(head) ? head : null, current: REF.test(current) ? current : null, remote };
}

// 레포 안의 상대 경로만. 옵션·절대 경로·상위 이동·제어 문자를 git 에 못 넘기게 한다
function checkPath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.startsWith('-') || /[\0\n\r]/.test(p) || p.split('/').includes('..')) throw new Error('bad path');
  return p;
}
const lineNo = (n) => { if (!Number.isInteger(n) || n < 1) throw new Error('bad line'); return n; };
const trimNl = (s) => s.replace(/\n$/, '');

// 렌더러에 노출하지 않는 main 내부 전용 — repo:git IPC 는 ops 만 본다. 모두 읽기 전용, textconv·ext-diff 끔
const askGit = {
  worktrees: async (repo) => {
    const out = await git(repo, ['worktree', 'list', '--porcelain']);
    const dirs = out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    return Promise.all(dirs.map((d) => fs.realpath(d).catch(() => d)));
  },
  isCommit: async (repo, x) => {
    if (typeof x !== 'string' || !OID.test(x)) return false;
    return (await git(repo, ['cat-file', '-t', x]).then((s) => s.trim(), () => null)) === 'commit';
  },
  // 그 커밋 시점의 파일 내용. 없거나 blob 이 아니면 null
  fileAt: async (repo, commit, p, o) => {
    const spec = `${oid(commit)}:${checkPath(p)}`;
    const id = await git(repo, ['rev-parse', '--verify', '--end-of-options', spec], o).then((s) => s.trim(), () => null);
    if (!id) return null;
    if ((await git(repo, ['cat-file', '-t', id], o).then((s) => s.trim(), () => null)) !== 'blob') return null;
    return git(repo, ['cat-file', 'blob', id], o);
  },
  blameLine: async (repo, commit, p, line, o) => {
    const out = await git(repo, ['blame', '--porcelain', '--no-textconv', '-L', `${lineNo(line)},${line}`, oid(commit), '--', checkPath(p)], o).catch(() => null);
    if (out === null) return null;
    const sha = out.split('\n', 1)[0].split(' ')[0];
    const time = /^committer-time (\d+)$/m.exec(out);
    const summary = /^summary (.*)$/m.exec(out);
    if (!OID.test(sha) || !time) return null;
    return { sha, committerTime: Number(time[1]) * 1000, summary: summary ? summary[1] : '' };
  },
  logLine: async (repo, commit, p, line, o) => {
    const out = await git(repo, ['log', '-L', `${lineNo(line)},${line}:${checkPath(p)}`, oid(commit), '-n', '3', '-s', '--no-textconv', '--no-ext-diff', '--format=%H%x09%ad%x09%B'], o);
    return out.slice(0, 8000);
  },
  // mergeBase..head 에서 text 의 개수를 바꾼 가장 최근 커밋(지운 커밋 후보)
  deletingCommit: async (repo, mergeBase, head, p, text, o) => {
    if (typeof text !== 'string' || text === '' || text.includes('\0')) throw new Error('bad text');
    const out = await git(repo, ['log', `-S${text}`, '--no-textconv', '--no-ext-diff', '--format=%H%x09%ct%x09%s', `${oid(mergeBase)}..${oid(head)}`, '--', checkPath(p)], o);
    const first = trimNl(out).split('\n', 1)[0];
    if (!first) return null;
    const [sha, ct, ...rest] = first.split('\t');
    return OID.test(sha) ? { sha, committerTime: Number(ct) * 1000, summary: rest.join('\t') } : null;
  },
};

const ops = {
  resolve: (repo, r) => git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref(r)}^{commit}`]).then((s) => s.trim()),
  mergeBase: (repo, a, b) => git(repo, ['merge-base', oid(a), oid(b)]).then((s) => s.trim()),
  rawDiff: (repo, a, b) => git(repo, [...DIFF, '--raw', '-z', oid(a), oid(b)]),
  patchDiff: (repo, a, b) => git(repo, [...DIFF, '-p', '-U3', '--diff-algorithm=myers', oid(a), oid(b)]),
  // 없는 객체·blob 아닌 객체는 null(화면이 '이전 버전 없음'을 보인다). 그 밖의 실패는 그대로 던진다
  blob: async (repo, a) => {
    const type = await git(repo, ['cat-file', '-t', oid(a)]).then((s) => s.trim(), () => null);
    if (type !== 'blob') return null;
    return git(repo, ['cat-file', 'blob', a]);
  },
};

module.exports = { createRepos, info, ops, askGit, checkPath };
