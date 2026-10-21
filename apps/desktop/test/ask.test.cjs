const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAsk } = require('../ask/index.cjs');
const P = require('../ask/prompt.cjs');

// 질문 흐름은 가짜 deps 로만 돈다 — 실제 git·claude·세션 기록은 부르지 않는다
const REPO = '/home/u/repo';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const BLAME = { sha: 'c'.repeat(40), committerTime: 1_700_000_000_000, summary: 'add foo' };
const DEL = { sha: 'd'.repeat(40), committerTime: 1_700_000_100_000, summary: 'drop old foo' };
const FILE = 'line one\nconst foo = compute(1);\nline three\n';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function req(over = {}) {
  return { id: `q-${Math.random().toString(36).slice(2)}`, repo: REPO, head: HEAD, mergeBase: BASE, path: 'src/a.ts',
    side: 'R', line: 2, lineText: 'const foo = compute(1);', question: '왜 바꿨어?', history: [], lang: 'ko', ...over };
}

// calls 에 호출을 남기는 가짜 deps. over 로 갈아끼운다
function deps(over = {}) {
  const calls = { git: [], findAuthoring: [], runClaude: [], claudeVersion: 0, progress: [] };
  const git = {
    worktrees: async (repo, o) => { calls.git.push(['worktrees', o]); return [repo, '/home/u/wt']; },
    isCommit: async (repo, x, o) => { calls.git.push(['isCommit', x, o]); return x === HEAD || x === BASE; },
    fileAt: async (repo, commit, p, o) => { calls.git.push(['fileAt', commit, p, o]); return FILE; },
    blameLine: async (repo, commit, p, line, o) => { calls.git.push(['blameLine', commit, p, line, o]); return BLAME; },
    logLine: async (repo, commit, p, line, o) => { calls.git.push(['logLine', commit, p, line, o]); return `${BLAME.sha}\tdate\tadd foo\n`; },
    deletingCommit: async (repo, mb, head, p, text, o) => { calls.git.push(['deletingCommit', mb, head, p, text, o]); return DEL; },
    ...(over.askGit || {}),
  };
  const d = {
    allowed: async (repo) => { if (repo !== REPO) throw new Error('repository not added'); return repo; },
    askGit: git,
    findAuthoring: async (a) => { calls.findAuthoring.push(a); return { found: true, sessionId: 'e5f37e58-0000', at: 1_699_999_999_000, subagent: false, excerpt: 'EXCERPT-TEXT' }; },
    sessionStores: () => ['/home/u/.claude/projects'],
    allowDirs: () => ['/tmp'],
    findClaude: async () => '/home/u/.local/bin/claude',
    claudeVersion: async () => { calls.claudeVersion++; return '2.1.305'; },
    runClaude: async (a) => { calls.runClaude.push(a); return { ok: true, stdout: JSON.stringify({ result: 'ANSWER' }), stderr: '' }; },
    readResult: (stdout) => ({ ok: true, answer: JSON.parse(stdout).result }),
    accountEmail: () => 'you@example.com',
    env: {},
    home: '/home/u',
    onProgress: (id, stage) => calls.progress.push([id, stage]),
    ...over,
  };
  d.askGit = git;
  return { d, calls };
}

test('malformed requests are refused', async () => {
  const { d, calls } = deps();
  const ask = createAsk(d);
  const bad = [
    req({ question: 'x'.repeat(2001) }),
    req({ history: Array.from({ length: 4 }, () => ({ q: 'q', a: 'a' })) }),
    req({ line: 0 }),
    req({ path: '../x' }),
    req({ head: 'HEAD' }),
    req({ history: [{ q: 'q', a: 'a'.repeat(4001) }] }),
    req({ lineText: 'x'.repeat(2001) }),
    req({ side: 'X' }),
    req({ side: 'L', mergeBase: undefined }),
    req({ lang: 'fr' }),
    req({ question: '' }),
  ];
  for (const r of bad) assert.deepEqual(await ask.start(r), { ok: false, error: 'invalid' }, JSON.stringify(r).slice(0, 80));
  assert.deepEqual(await ask.start(null), { ok: false, error: 'invalid' });
  assert.equal(calls.runClaude.length, 0);
  assert.equal(calls.progress.length, 0);   // 검증에서 떨어진 질문은 등록되지 않는다
  // 추가하지 않은 폴더 · 커밋이 아닌 head 도 invalid
  assert.equal((await ask.start(req({ repo: '/home/u/other' }))).error, 'invalid');
  assert.equal((await ask.start(req({ head: 'e'.repeat(40) }))).error, 'invalid');
  assert.equal(calls.runClaude.length, 0);
});

test('a lineText that does not match the file is refused, CRLF is tolerated', async () => {
  const crlf = 'line one\r\nconst foo = compute(1);\r\nline three\r\n';
  const { d, calls } = deps({ askGit: { fileAt: async () => crlf } });
  const ask = createAsk(d);
  assert.equal((await ask.start(req())).ok, true);                                   // 파일은 CRLF, 보낸 줄은 \r 없음
  assert.equal((await ask.start(req({ lineText: 'const foo = compute(1);\r' }))).ok, true);
  assert.deepEqual(await ask.start(req({ lineText: 'const foo = compute(2);' })), { ok: false, error: 'invalid' });
  assert.deepEqual(await ask.start(req({ line: 4 })), { ok: false, error: 'invalid' });   // 줄 수를 넘는다(끝 개행 뒤 빈 줄은 줄이 아니다)
  const lf = deps();
  const ask2 = createAsk(lf.d);
  assert.equal((await ask2.start(req({ lineText: 'const foo = compute(1);\r' }))).ok, true);   // 파일은 LF, 보낸 줄에 \r
  assert.equal(calls.runClaude.length, 2);
  // 없는 파일 → invalid
  const gone = deps({ askGit: { fileAt: async () => null } });
  assert.deepEqual(await createAsk(gone.d).start(req()), { ok: false, error: 'invalid' });
});

test('a git step that runs past the deadline is a timeout, not invalid', async () => {
  let t = 0;
  // fileAt 이 도는 사이 시계가 마감을 넘는다 — git 이 execFile 타임아웃으로 죽으면 fileAt 은 null 을 돌려준다
  const { d, calls } = deps({ now: () => t, timeoutMs: 1000, askGit: { fileAt: async () => { t += 2000; return null; } } });
  assert.deepEqual(await createAsk(d).start(req()), { ok: false, error: 'timeout' });
  assert.equal(calls.runClaude.length, 0);
  const dl = deps({ askGit: { blameLine: async () => { throw new Error('deadline'); } } });
  assert.deepEqual(await createAsk(dl.d).start(req()), { ok: false, error: 'timeout' });
});

test('questions run one at a time and the deadline starts at the slot', async () => {
  let running = 0, peak = 0;
  const { d, calls } = deps({
    timeoutMs: 1000,
    runClaude: async (a) => {
      calls.runClaude.push(a);
      running++; peak = Math.max(peak, running);
      await tick(300);
      running--;
      return { ok: true, stdout: JSON.stringify({ result: 'A' }), stderr: '' };
    },
  });
  const ask = createAsk(d);
  const [a, b] = await Promise.all([ask.start(req()), ask.start(req())]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(peak, 1);
  assert.equal(calls.runClaude.length, 2);
  // 두 번째는 300ms 넘게 기다렸지만 마감은 슬롯을 잡은 때부터라 거의 통째로 남는다
  assert.ok(calls.runClaude[1].timeoutMs > 800, `second timeoutMs ${calls.runClaude[1].timeoutMs}`);
  assert.ok(calls.runClaude[1].timeoutMs <= 1000);
  const gitTimeouts = calls.git.map((c) => c[c.length - 1]).filter((o) => o && 'timeoutMs' in o).map((o) => o.timeoutMs);
  assert.ok(gitTimeouts.length > 0 && gitTimeouts.every((ms) => ms > 0 && ms <= 1000));
});

test('progress goes queued → searching → answering', async () => {
  let release;
  const { d, calls } = deps({ runClaude: async (a) => { calls.runClaude.push(a); if (calls.runClaude.length === 1) await new Promise((r) => { release = r; }); return { ok: true, stdout: '{"result":"x"}', stderr: '' }; } });
  const ask = createAsk(d);
  const r1 = req(), r2 = req();
  const p1 = ask.start(r1);
  const p2 = ask.start(r2);
  while (!release) await tick(5);
  const of = (id) => calls.progress.filter((p) => p[0] === id).map((p) => p[1]);
  assert.deepEqual(of(r1.id), ['queued', 'searching', 'answering']);
  assert.deepEqual(of(r2.id), ['queued']);   // 첫 질문이 도는 동안은 대기
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(of(r2.id), ['queued', 'searching', 'answering']);
});

test('cancelling a queued question never runs claude', async () => {
  let release;
  const { d, calls } = deps({ runClaude: async (a) => { calls.runClaude.push(a); await new Promise((r) => { release = r; }); return { ok: true, stdout: '{"result":"x"}', stderr: '' }; } });
  const ask = createAsk(d);
  const r1 = req(), r2 = req();
  const p1 = ask.start(r1);
  const p2 = ask.start(r2);
  while (!release) await tick(5);
  ask.cancel(r2.id);
  assert.deepEqual(await p2, { ok: false, error: 'cancelled' });
  release();
  assert.equal((await p1).ok, true);
  assert.equal(calls.runClaude.length, 1);
  assert.ok(!calls.progress.some((p) => p[0] === r2.id && p[1] !== 'queued'));
  ask.cancel('no-such-id');   // 모르는 id 는 조용히 넘어간다
  // 같은 id 가 아직 돌고 있으면 두 번째는 받지 않는다
  release = null;
  const r3 = req();
  const p3 = ask.start(r3);
  assert.deepEqual(await ask.start({ ...r3 }), { ok: false, error: 'invalid' });
  while (!release) await tick(5);
  release();
  assert.equal((await p3).ok, true);
});

test('cancelAll stops the running one', async () => {
  const { d, calls } = deps({
    runClaude: (a) => new Promise((resolve) => {
      calls.runClaude.push(a);
      if (calls.runClaude.length > 1) return resolve({ ok: true, stdout: '{"result":"x"}', stderr: '' });
      a.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true });
    }),
  });
  const ask = createAsk(d);
  const r1 = req(), r2 = req();
  const p1 = ask.start(r1);
  const p2 = ask.start(r2);
  while (calls.runClaude.length === 0) await tick(5);
  ask.cancelAll();
  assert.deepEqual(await p1, { ok: false, error: 'cancelled' });
  assert.deepEqual(await p2, { ok: false, error: 'cancelled' });
  assert.equal(calls.runClaude.length, 1);
  // 슬롯이 풀려 다음 질문은 돈다
  assert.equal((await ask.start(req())).ok, true);
  assert.equal(calls.runClaude.length, 2);
  // 탐색 중(runClaude 전)에 취소돼도 claude 는 안 돈다
  let hold;
  const mid = deps({ findAuthoring: async () => { await new Promise((r) => { hold = r; }); return { found: false, reason: 'not-found' }; } });
  const askMid = createAsk(mid.d);
  const pm = askMid.start(req());
  while (!hold) await tick(5);
  askMid.cancelAll();
  hold();
  assert.deepEqual(await pm, { ok: false, error: 'cancelled' });
  assert.equal(mid.calls.runClaude.length, 0);
});

test('source says which session answered, or why none', async () => {
  const { d, calls } = deps();
  const r = await createAsk(d).start(req());
  assert.deepEqual(r, { ok: true, answer: 'ANSWER', source: { kind: 'session', sessionId: 'e5f37e58-0000', at: 1_699_999_999_000, subagent: false }, account: 'you@example.com' });
  const a = calls.findAuthoring[0];
  assert.equal(a.text, 'const foo = compute(1);');
  assert.equal(a.side, 'R');
  assert.equal(a.until, BLAME.committerTime + 999);   // 커밋 시각은 초 단위 — 같은 초 안의 편집도 든다
  assert.deepEqual(a.roots, [REPO, '/home/u/wt']);
  assert.deepEqual(a.files, [path.join(REPO, 'src/a.ts'), path.join('/home/u/wt', 'src/a.ts')]);
  assert.deepEqual(a.stores, ['/home/u/.claude/projects']);
  assert.ok(Number.isFinite(a.deadline));
  assert.match(calls.runClaude[0].stdin, /EXCERPT-TEXT/);
  assert.deepEqual(calls.runClaude[0].args, require('../ask/claude-run.cjs').buildArgs(P.INSTRUCTION, P.systemPrompt('ko')));

  for (const reason of ['short-line', 'not-found', 'mixed', 'no-human', 'timeout', 'unreadable']) {
    const n = deps({ findAuthoring: async () => ({ found: false, reason }) });
    const res = await createAsk(n.d).start(req());
    assert.deepEqual(res.source, { kind: 'none', reason });
    assert.match(n.calls.runClaude[0].stdin, new RegExp(`없음 — ${reason}`));
  }

  // L 줄: merge-base 쪽 좌표·previousPath, 지운 커밋 시각이 기준
  const l = deps();
  const rl = await createAsk(l.d).start(req({ side: 'L', previousPath: 'src/old.ts' }));
  assert.equal(rl.ok, true);
  assert.deepEqual(l.calls.git.find((c) => c[0] === 'fileAt').slice(1, 3), [BASE, 'src/old.ts']);
  assert.deepEqual(l.calls.git.find((c) => c[0] === 'blameLine').slice(1, 4), [BASE, 'src/old.ts', 2]);
  const dc = l.calls.git.find((c) => c[0] === 'deletingCommit');
  assert.deepEqual(dc.slice(1, 5), [BASE, HEAD, 'src/old.ts', 'const foo = compute(1);']);
  assert.equal(l.calls.findAuthoring[0].until, DEL.committerTime + 999);
  assert.equal(l.calls.findAuthoring[0].side, 'L');
  assert.deepEqual(l.calls.findAuthoring[0].files, [path.join(REPO, 'src/old.ts'), path.join('/home/u/wt', 'src/old.ts')]);
  assert.match(l.calls.runClaude[0].stdin, new RegExp(DEL.sha));

  // 기준 커밋을 못 구하면 세션은 찾지 않는다
  const nb = deps({ askGit: { blameLine: async () => null } });
  const rnb = await createAsk(nb.d).start(req());
  assert.deepEqual(rnb.source, { kind: 'none', reason: 'not-found' });
  assert.equal(nb.calls.findAuthoring.length, 0);

  // 세션을 찾기 전에 마감이 다 됐으면 no-time
  let t = 0;
  const nt = deps({ now: () => t, timeoutMs: 1000, claudeVersion: async () => { t += 5000; return '2.1.305'; } });
  const rnt = await createAsk(nt.d).start(req());
  assert.equal(nt.calls.findAuthoring.length, 0);
  assert.deepEqual(rnt.source, { kind: 'none', reason: 'no-time' });   // 가짜 runClaude 는 마감을 안 본다
  assert.match(nt.calls.runClaude[0].stdin, /없음 — no-time/);
  assert.ok(nt.calls.runClaude[0].timeoutMs <= 0);   // 진짜 runClaude 는 띄우지 않고 timeout 을 돌려준다
});

test('claude failures map to the result errors', async () => {
  for (const [res, want] of [
    [{ ok: false, error: 'timeout' }, 'timeout'],
    [{ ok: false, error: 'cancelled' }, 'cancelled'],
    [{ ok: false, error: 'too-big' }, 'failed'],
    [{ ok: false, error: 'spawn' }, 'failed'],
  ]) {
    const { d } = deps({ runClaude: async () => res });
    const r = await createAsk(d).start(req());
    assert.equal(r.ok, false); assert.equal(r.error, want);
    if (want === 'failed') assert.equal(typeof r.message, 'string');
  }
  const login = deps({ readResult: () => ({ ok: false, error: 'login', message: 'log in' }) });
  assert.deepEqual(await createAsk(login.d).start(req()), { ok: false, error: 'login', message: 'log in' });
  const noAcct = deps({ accountEmail: () => null });
  assert.equal((await createAsk(noAcct.d).start(req())).account, null);
  // 빈 CLAUDE_CONFIG_DIR 은 없는 것 — claude 에 넘기는 env 에서 빠지고, GIT_* 도 빠진다
  const env = deps({ env: { CLAUDE_CONFIG_DIR: '', GIT_DIR: '/x', HOME: '/home/u' } });
  await createAsk(env.d).start(req());
  assert.deepEqual(env.calls.runClaude[0].env, { HOME: '/home/u' });
});

test('missing or old claude gives not-installed or too-old', async () => {
  const none = deps({ findClaude: async () => null });
  assert.equal((await createAsk(none.d).start(req())).error, 'not-installed');
  assert.equal(none.calls.runClaude.length, 0);
  const broken = deps({ claudeVersion: async () => null });
  assert.equal((await createAsk(broken.d).start(req())).error, 'not-installed');
  const old = deps({ claudeVersion: async () => '2.1.247' });
  const r = await createAsk(old.d).start(req());
  assert.equal(r.error, 'too-old');
  assert.match(r.message, /2\.1\.248/);
  assert.equal(old.calls.runClaude.length, 0);
  // 버전은 앱 실행당 한 번만 본다
  const ok = deps();
  const ask = createAsk(ok.d);
  await ask.start(req()); await ask.start(req());
  assert.equal(ok.calls.claudeVersion, 1);
});

test('materials stay within the caps and mark cuts', () => {
  const big = {
    path: 'src/a.ts', side: 'R', line: 100, commit: HEAD,
    lineText: 'L'.repeat(2000),
    fileLines: Array.from({ length: 300 }, (_, i) => `${i + 1}:${'x'.repeat(1000)}`),
    git: { blame: BLAME, log: 'G'.repeat(20000) },
    session: { found: true, sessionId: 'e5f37e58-0000', at: 0, subagent: false, excerpt: 'S'.repeat(40000) },
    history: Array.from({ length: 3 }, () => ({ q: 'Q'.repeat(4000), a: 'A'.repeat(4000) })),
    question: '?'.repeat(2000),
  };
  const s = P.materials(big);
  assert.ok(s.length <= 60000, `length ${s.length}`);
  assert.ok(s.includes('…(잘림)'));
  assert.ok(s.includes('?'.repeat(2000)));       // 질문은 통째로
  assert.ok(s.includes('L'.repeat(2000)));       // 그 줄도
  assert.ok(!s.includes('G'.repeat(8001)));      // log 근거 8000자
  assert.ok(!s.includes('S'.repeat(30001)));     // 세션 발췌 30000자
  assert.ok(!s.includes('x'.repeat(501)));       // 주변 줄은 줄당 500자
  assert.ok(s.includes('100:'), 'the target line number stays');

  const small = P.materials({
    path: 'src/a.ts', side: 'L', line: 2, commit: BASE, lineText: 'const foo = compute(1);',
    fileLines: ['line one', 'const foo = compute(1);', 'line three'],
    git: { deleting: DEL, blame: BLAME, log: '' },
    session: { found: false, reason: 'no-human' },
    history: [{ q: 'first q', a: 'first a' }],
    question: 'why?',
  });
  assert.ok(!small.includes('…(잘림)'));
  for (const part of ['src/a.ts', BASE, 'line one', 'line three', DEL.sha, BLAME.sha, '없음 — no-human', 'first q', 'first a', 'why?']) assert.ok(small.includes(part), part);
  // ±40줄만
  const far = P.materials({ ...big, fileLines: Array.from({ length: 200 }, (_, i) => `row${i + 1}end`), line: 100, history: [], git: {}, session: { found: false, reason: 'not-found' }, question: 'q', lineText: 'row100end' });
  assert.ok(far.includes('row60end') && far.includes('row140end'));
  assert.ok(!far.includes('row59end') && !far.includes('row141end'));
});

test('system prompt carries the five rules in the app language', () => {
  const ko = P.systemPrompt('ko'), en = P.systemPrompt('en');
  assert.match(ko, /한국어/); assert.match(en, /English/);
  for (const s of [ko, en]) assert.equal(s.split('\n').filter((l) => /^\d\./.test(l)).length, 5);
  assert.equal(typeof P.INSTRUCTION, 'string');
  assert.ok(P.INSTRUCTION.length > 0 && !P.INSTRUCTION.includes('\n'));
});
