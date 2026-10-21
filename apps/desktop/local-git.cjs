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
    // execFile 은 0 을 '무제한'으로, 음수·소수는 동기 예외로 다룬다 — 마감이 지났으면 git 을 띄우지 않고 거절한다
    const t = Math.floor(timeoutMs);
    if (!Number.isFinite(t) || t < 1) { reject(new Error('deadline')); return; }
    execFile('git', ['-C', repo, ...BASE, ...args], { env: env(), maxBuffer: 64 << 20, timeout: t, encoding: 'utf8' }, (err, stdout, stderr) => {
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
  const cfg = (k) => git(repo, ['config', '--get', k]).then((v) => v.replace(/\n$/, ''), () => '');   // 없으면 git 이 1 로 끝난다
  const user = { name: await cfg('user.name'), email: await cfg('user.email') };
  return { refs, defaultBase: REF.test(head) ? head : null, current: REF.test(current) ? current : null, remote, user };
}

// 레포 안의 상대 경로만. 옵션·절대 경로·상위 이동·제어 문자를 git 에 못 넘기게 한다
function checkPath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.startsWith('-') || /[\0\n\r]/.test(p) || p.split('/').includes('..')) throw new Error('bad path');
  return p;
}
const lineNo = (n) => { if (!Number.isInteger(n) || n < 1) throw new Error('bad line'); return n; };
// 실패는 null 로 삼키되 마감 초과는 그대로 던진다
const soft = (e) => { if (e && e.message === 'deadline') throw e; return null; };
const trimNl = (s) => s.replace(/\n$/, '');

// 렌더러에 노출하지 않는 main 내부 전용 — repo:git IPC 는 ops 만 본다. 모두 읽기 전용, textconv·ext-diff 끔
const askGit = {
  worktrees: async (repo, o) => {
    const out = await git(repo, ['worktree', 'list', '--porcelain', '-z'], o);   // NUL 구분 — 경로의 개행이 가짜 루트를 못 만든다
    const dirs = out.split('\0').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    return Promise.all(dirs.map((d) => fs.realpath(d).catch(() => d)));
  },
  isCommit: async (repo, x, o) => {
    if (typeof x !== 'string' || !OID.test(x)) return false;
    return (await git(repo, ['cat-file', '-t', x], o).then((s) => s.trim(), soft)) === 'commit';
  },
  // 그 커밋 시점의 파일 내용. 없거나 blob 이 아니면 null
  fileAt: async (repo, commit, p, o) => {
    const spec = `${oid(commit)}:${checkPath(p)}`;
    const id = await git(repo, ['rev-parse', '--verify', '--end-of-options', spec], o).then((s) => s.trim(), soft);
    if (!id) return null;
    if ((await git(repo, ['cat-file', '-t', id], o).then((s) => s.trim(), soft)) !== 'blob') return null;
    return git(repo, ['cat-file', 'blob', id], o);
  },
  blameLine: async (repo, commit, p, line, o) => {
    const out = await git(repo, ['blame', '--porcelain', '--no-textconv', '-L', `${lineNo(line)},${line}`, oid(commit), '--', checkPath(p)], o).catch(soft);
    if (out === null) return null;
    const sha = out.split('\n', 1)[0].split(' ')[0];
    const time = /^committer-time (\d+)$/m.exec(out);
    const summary = /^summary (.*)$/m.exec(out);
    if (!OID.test(sha) || !time) return null;
    return { sha, committerTime: Number(time[1]) * 1000, summary: summary ? summary[1] : '' };
  },
  logLine: async (repo, commit, p, line, o) => {
    const out = await git(repo, ['log', '-L', `${lineNo(line)},${line}:${checkPath(p)}`, oid(commit), '-n', '3', '-s', '--no-textconv', '--no-ext-diff', '--no-show-signature', '--format=%H%x09%ad%x09%B'], o);
    return out.slice(0, 8000);
  },
  // mergeBase..head 에서 text 의 개수를 바꾼 가장 최근 커밋(지운 커밋 후보)
  deletingCommit: async (repo, mergeBase, head, p, text, o) => {
    if (typeof text !== 'string' || text === '' || text.includes('\0')) throw new Error('bad text');
    const out = await git(repo, ['--literal-pathspecs', 'log', `-S${text}`, '--no-show-signature', '--no-textconv', '--no-ext-diff', '--format=%H%x09%ct%x09%s', `${oid(mergeBase)}..${oid(head)}`, '--', checkPath(p)], o);
    const first = trimNl(out).split('\n', 1)[0];
    if (!first) return null;
    const [sha, ct, ...rest] = first.split('\t');
    return OID.test(sha) ? { sha, committerTime: Number(ct) * 1000, summary: rest.join('\t') } : null;
  },
};

// log 한 번의 -z 출력 → 경로별 작성자. 경로는 NUL 말고 아무 바이트나 가질 수 있으므로 NUL 토큰만으로 짠다:
// 커밋 머리 = 빈 토큰 둘 + 'N'이름 + 'E'메일(경로는 비어 있을 수 없어 위조 불가). 머지 --cc 는 머리 뒤에 빈 토큰이 하나 더 끼고,
// 머지가 아닌 커밋은 첫 경로 앞에 구분 개행이 하나 붙는다
const AUTHOR_FMT = '--format=%x00%x00N%aN%x00E%aE';
function collectAuthors(out, files) {
  const t = out.split('\0');
  let i = 0;
  while (i < t.length) {
    while (i < t.length && t[i] === '') i++;
    if (i + 1 >= t.length) break;
    const name = t[i].slice(1), email = t[i + 1].slice(1);
    i += 2;
    let first = true;
    if (t[i] === '') { i++; first = false; }   // 머지: 구분 개행 없음
    for (; i < t.length && t[i] !== ''; i++) {
      const f = first && t[i].startsWith('\n') ? t[i].slice(1) : t[i];
      first = false;
      const list = files[f] ?? (files[f] = []);
      if (!list.some(([n, e]) => n === name && e === email)) list.push([name, email]);
    }
  }
}

// blame --porcelain: 커밋의 메타는 처음 나올 때만 있다. 경계 커밋(범위 밖) 줄은 null
function parseBlame(out) {
  const meta = new Map();
  const result = [];
  let cur = null, final = 0;
  for (const l of out.split('\n')) {
    if (l.startsWith('\t')) {
      const m = meta.get(cur);
      result[final - 1] = m && !m.boundary && m.name !== undefined ? [m.name, m.email] : null;
      continue;
    }
    const h = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(l);
    if (h) { cur = h[1]; final = Number(h[2]); if (!meta.has(cur)) meta.set(cur, { boundary: false }); continue; }
    const m = meta.get(cur);
    if (!m) continue;
    if (l.startsWith('author ')) m.name = l.slice(7);
    else if (l.startsWith('author-mail ')) m.email = l.slice(12).replace(/^</, '').replace(/>$/, '');
    else if (l === 'boundary') m.boundary = true;
  }
  return Array.from(result, (x) => x ?? null);   // 빈 칸 없이
}

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
  // mergeBase..head 에서 경로를 바꾼 작성자(.mailmap 적용). 머지 커밋은 --cc 로 충돌을 푼 사람만 잡힌다
  authors: async (repo, mergeBase, head) => {
    const range = `${oid(mergeBase)}..${oid(head)}`;
    const fmt = AUTHOR_FMT;
    const o = { timeoutMs: 10_000 };
    const [plain, merges] = await Promise.all([
      git(repo, ['log', '--no-merges', '-M', '-z', '--name-only', '--no-show-signature', '--no-textconv', '--no-ext-diff', fmt, range], o),
      git(repo, ['log', '--merges', '--cc', '-z', '--name-only', '--no-show-signature', '--no-textconv', '--no-ext-diff', fmt, range], o),
    ]);
    const files = Object.create(null);   // constructor·__proto__ 같은 경로가 상속 속성으로 풀리지 않게
    collectAuthors(plain, files);
    collectAuthors(merges, files);
    return JSON.stringify({ files });
  },
  // head 파일의 줄별 작성자 — 인덱스 n-1 이 줄 n. mergeBase 이전(경계) 줄과 실패는 null
  blameAuthors: async (repo, head, p, mergeBase) => {
    const range = `${oid(mergeBase)}..${oid(head)}`;
    const out = await git(repo, ['blame', '--porcelain', '--no-textconv', range, '--', checkPath(p)], { timeoutMs: 10_000 }).catch(soft);
    return JSON.stringify(out === null ? null : parseBlame(out));
  },
};

module.exports = { createRepos, info, ops, askGit, checkPath };
