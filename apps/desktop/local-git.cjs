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

function git(repo, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...BASE, ...args], { env: env(), maxBuffer: 64 << 20, timeout: 60_000, encoding: 'utf8' }, (err, stdout, stderr) => {
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

module.exports = { createRepos, info, ops };
