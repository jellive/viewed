const fs = require('node:fs');
const path = require('node:path');
const { checkPath } = require('../local-git.cjs');
const { MIN_VERSION, versionAtLeast, cleanEnv, buildArgs } = require('./claude-run.cjs');
const sessions = require('./sessions.cjs');
const P = require('./prompt.cjs');

// 질문 한 번의 흐름(spec §4): 모양 검증 → 등록 → 슬롯 대기 → (마감 시작) git 근거 → 작성 세션 → Claude → AskResult.
// electron 에 의존하지 않는다 — git·세션·claude 는 전부 deps 로 받아 단위 테스트가 가짜로 돌린다.

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LIMIT = Object.freeze({ question: 2000, lineText: 2000, pairs: 3, item: 4000, id: 200, path: 4096 });
const MSG_FAILED = '답을 못 받았어요. 다시 시도해 주세요';
const VERSION_TIMEOUT_MS = 5000;
const MSG_TOO_OLD = `Claude Code ${MIN_VERSION} 이상 필요`;

const str = (x, max) => typeof x === 'string' && x.length <= max;
// 정규화된 상대 경로만(./·//·끝 아닌 . 조각 없음) — 자료 머리가 경로로 부풀지 않게 길이도 막는다
const okPath = (p) => {
  try { checkPath(p); } catch { return false; }
  return p.length <= LIMIT.path && p === path.posix.normalize(p) && p !== '.';
};
const noCr = (s) => s.replace(/\r$/, '');

// 렌더러가 보낸 요청의 모양만 본다(레포·커밋·파일 존재는 슬롯을 잡은 뒤)
function valid(r) {
  if (!r || typeof r !== 'object') return false;
  if (!str(r.id, LIMIT.id) || !r.id || typeof r.repo !== 'string' || !r.repo) return false;
  if (typeof r.head !== 'string' || !OID.test(r.head)) return false;
  if (r.mergeBase !== undefined && (typeof r.mergeBase !== 'string' || !OID.test(r.mergeBase))) return false;
  if (r.side !== 'L' && r.side !== 'R') return false;
  if (r.side === 'L' && r.mergeBase === undefined) return false;
  if (!okPath(r.path) || (r.previousPath !== undefined && !okPath(r.previousPath))) return false;
  if (!Number.isInteger(r.line) || r.line < 1) return false;
  if (!str(r.lineText, LIMIT.lineText)) return false;
  if (!str(r.question, LIMIT.question) || !r.question.trim()) return false;
  if (!Array.isArray(r.history) || r.history.length > LIMIT.pairs) return false;
  if (!r.history.every((h) => h && str(h.q, LIMIT.item) && str(h.a, LIMIT.item))) return false;
  if (r.lang !== 'ko' && r.lang !== 'en') return false;
  return true;
}

// 흐름을 끝내는 결과를 실어 던진다
class Stop { constructor(result) { this.result = result; } }

// deps = { allowed, askGit, findAuthoring, sessionStores, findClaude, claudeVersion, runClaude, readResult, accountEmail, env, home,
//          onProgress(id, stage), timeoutMs = 90_000, allowDirs?, now? }
function createAsk(deps) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const total = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 90_000;
  const allowDirs = deps.allowDirs || sessions.allowDirs;
  const progress = (id, stage) => { try { deps.onProgress && deps.onProgress(id, stage); } catch { /* 알림 실패는 흐름을 안 막는다 */ } };
  // 빈 CLAUDE_CONFIG_DIR 은 없는 것으로 본다
  const env = { ...(deps.env || process.env) };
  if (env.CLAUDE_CONFIG_DIR === '') delete env.CLAUDE_CONFIG_DIR;
  const realHome = (() => { try { return deps.home ? fs.realpathSync(deps.home) : deps.home; } catch { return deps.home; } })();

  const jobs = new Map();   // id → { ac, wake }
  const waiting = [];
  let busy = false;
  const versions = new Map();   // claude 경로 → 버전(앱 실행당 한 번)

  // 슬롯은 하나. 다음 대기자에게 넘기거나 비운다
  const release = () => {
    const next = waiting.shift();
    if (next) next.wake(true); else busy = false;
  };

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return;
    job.ac.abort();
    const i = waiting.indexOf(job);
    if (i !== -1) { waiting.splice(i, 1); job.wake(false); }
  }
  function cancelAll() { for (const id of [...jobs.keys()]) cancel(id); }

  async function run(r, job, deadline) {
    const left = () => deadline - now();
    const late = () => left() <= 0;
    const check = () => { if (job.ac.signal.aborted) throw new Stop({ ok: false, error: 'cancelled' }); };
    const TIMEOUT = new Stop({ ok: false, error: 'timeout' });
    const INVALID = new Stop({ ok: false, error: 'invalid' });
    // 기다리는 모든 단계를 취소·마감과 겨룬다 — 끝나지 않는 약속이 앱 전체의 슬롯을 붙잡지 못하게.
    // 진 쪽 약속은 그대로 두되(git 은 자기 타임아웃, 세션 탐색은 deadline 으로 끝난다) 거절이 새지 않게 삼킨다
    // 시작 전에 취소·마감을 보고 나서 부른다(fn 은 약속을 돌려주는 함수)
    const within = (fn) => {
      check();
      if (late()) throw TIMEOUT;
      let timer = null, onAbort = null;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(TIMEOUT), Math.max(0, left()));
        onAbort = () => reject(new Stop({ ok: false, error: 'cancelled' }));
        job.ac.signal.addEventListener('abort', onAbort, { once: true });
      });
      let work;
      try { work = Promise.resolve(fn()); } catch (e) { work = Promise.reject(e); }
      work.catch(() => {});
      return Promise.race([work, guard]).finally(() => { clearTimeout(timer); job.ac.signal.removeEventListener('abort', onAbort); });
    };
    // git 에 넘기는 옵션. timeoutMs 는 읽을 때마다 그때 남은 시간 — 여러 번 git 을 부르는 askGit 함수도 하위 호출마다 새로 잰다
    const budget = { get timeoutMs() { return left(); } };
    // git 한 단계. 'deadline' 은 timeout. 실패·null·false 는 마감이 지났으면 timeout(execFile 타임아웃으로 죽은 git 은 null 로 보인다),
    // 아니면 fallback(Stop 이면 그 결과로 끝낸다)
    const step = async (fn, fallback) => {
      let v = null;
      try { v = await within(() => fn(budget)); } catch (e) {
        if (e instanceof Stop) throw e;
        check();
        if (e && e.message === 'deadline') throw TIMEOUT;
        v = null;
      }
      check();
      if (v !== null && v !== false) return v;
      if (late()) throw TIMEOUT;
      if (fallback instanceof Stop) throw fallback;
      return fallback;
    };
    const g = deps.askGit;

    let repo;
    try { repo = await within(() => deps.allowed(r.repo)); } catch (e) { if (e instanceof Stop) throw e; throw INVALID; }
    await step((o) => g.isCommit(repo, r.head, o), INVALID);
    if (r.side === 'L') await step((o) => g.isCommit(repo, r.mergeBase, o), INVALID);

    const L = r.side === 'L';
    const commit = L ? r.mergeBase : r.head;
    const filePath = L ? (r.previousPath ?? r.path) : r.path;
    const text = await step((o) => g.fileAt(repo, commit, filePath, o), INVALID);
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();   // 끝 개행 뒤는 줄이 아니다
    if (r.line > lines.length) throw INVALID;
    const line = noCr(lines[r.line - 1]);
    if (line !== noCr(r.lineText)) throw INVALID;   // 좌표가 맞다는 증명 — CRLF 파일은 \r 하나 차이를 허용

    // git 근거. 실패해도 질문은 계속한다(근거가 비어 있을 뿐)
    const git = {};
    let base = null;   // 세션 찾기 기준 커밋
    if (!L) {
      git.blame = await step((o) => g.blameLine(repo, r.head, r.path, r.line, o), null);
      git.log = await step((o) => g.logLine(repo, r.head, r.path, r.line, o), '');
      base = git.blame;
    } else {
      if (line.trim()) {
        git.deleting = await step((o) => g.deletingCommit(repo, r.mergeBase, r.head, filePath, line, o), null);
        if (!git.deleting && r.previousPath !== undefined && r.previousPath !== r.path) {
          git.deleting = await step((o) => g.deletingCommit(repo, r.mergeBase, r.head, r.path, line, o), null);
        }
      }
      git.blame = await step((o) => g.blameLine(repo, r.mergeBase, filePath, r.line, o), null);
      base = git.deleting;
    }
    const worktrees = await step((o) => g.worktrees(repo, o), []);
    const roots = [...new Set([repo, ...(Array.isArray(worktrees) ? worktrees : [])])];

    // claude 위치·버전
    const bin = await within(() => deps.findClaude(realHome, roots));
    if (!bin) throw new Stop({ ok: false, error: 'not-installed' });
    let ver = versions.get(bin);
    if (ver === undefined) {
      ver = await within(() => deps.claudeVersion(bin, Math.min(VERSION_TIMEOUT_MS, left())));
      if (!ver) { if (late()) throw TIMEOUT; throw new Stop({ ok: false, error: 'not-installed' }); }
      versions.set(bin, ver);
    }
    if (!versionAtLeast(ver, MIN_VERSION)) throw new Stop({ ok: false, error: 'too-old', message: MSG_TOO_OLD });
    check();

    // 그 줄을 쓴 세션. 이름이 바뀐 파일의 지운 줄은 옛 이름·새 이름 어느 쪽으로 편집됐을 수도 있다
    const names = [...new Set([filePath, r.path])];
    let session;
    if (!base || !Number.isFinite(base.committerTime)) session = { found: false, reason: 'not-found' };
    else if (late()) session = { found: false, reason: 'no-time' };
    else {
      try {
        session = await within(() => deps.findAuthoring({
          stores: deps.sessionStores(env, realHome), text: line, side: r.side,
          files: roots.flatMap((p) => names.map((n) => path.join(p, n))), roots, until: base.committerTime + 999,   // 커밋 시각은 초 단위
          home: realHome, allowDirs: allowDirs(env, realHome), deadline, now,
        }));
      } catch (e) { if (e instanceof Stop) throw e; session = { found: false, reason: 'unreadable' }; }
      if (!session || typeof session !== 'object') session = { found: false, reason: 'unreadable' };
    }
    check();
    const source = session.found
      ? { kind: 'session', sessionId: session.sessionId, at: session.at, subagent: !!session.subagent }
      : { kind: 'none', reason: session.reason };

    const stdin = P.materials({ path: filePath, side: r.side, line: r.line, commit, lineText: line, fileLines: lines.map(noCr),
      git, session, history: r.history, question: r.question });
    check();
    progress(r.id, 'answering');
    const out = await deps.runClaude({ bin, args: buildArgs(P.INSTRUCTION, P.systemPrompt(r.lang)), stdin, timeoutMs: left(),
      signal: job.ac.signal, env: cleanEnv(env) });
    if (!out.ok) {
      if (out.error === 'cancelled' || out.error === 'timeout') return { ok: false, error: out.error };
      return { ok: false, error: 'failed', message: MSG_FAILED };
    }
    check();
    const res = deps.readResult(out.stdout, out.stderr);
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
    return { ok: true, answer: res.answer, source, account: deps.accountEmail(env, realHome) };
  }

  async function start(r) {
    if (!valid(r) || jobs.has(r.id)) return { ok: false, error: 'invalid' };
    const job = { ac: new AbortController(), wake: null };
    jobs.set(r.id, job);
    progress(r.id, 'queued');
    let got;
    if (!busy) { busy = true; got = true; } else {
      got = await new Promise((res) => { job.wake = res; waiting.push(job); });
    }
    if (!got) { jobs.delete(r.id); return { ok: false, error: 'cancelled' }; }
    try {
      if (job.ac.signal.aborted) return { ok: false, error: 'cancelled' };
      const deadline = now() + total;   // 마감은 슬롯을 잡은 때부터
      progress(r.id, 'searching');
      return await run(r, job, deadline);
    } catch (e) {
      if (e instanceof Stop) return e.result;
      return { ok: false, error: 'failed', message: MSG_FAILED };
    } finally {
      jobs.delete(r.id);
      release();
    }
  }

  return { start, cancel, cancelAll };
}

module.exports = { createAsk };
