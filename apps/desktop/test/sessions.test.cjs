const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../ask/sessions.cjs');

const T0 = Date.parse('2026-10-15T05:00:00.000Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const LINE = 'const answer = compute();';

const mk = () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'viewed-sess-')));
  const home = path.join(base, 'home');
  const repo = path.join(home, 'repo');
  const store = path.join(base, 'projects');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(store, 'proj'), { recursive: true });
  return { base, home, repo, store, file: path.join(repo, 'src', 'a.ts') };
};

const turOf = (line) => ({ structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-let x;', `+${line}`] }] });

// 합성 기록 — Claude Code 2.1.x 모양만 흉내 낸다. 실제 ~/.claude 는 읽지 않는다.
function session(sid, o = {}) {
  const side = o.sidechain ? { isSidechain: true } : {};
  const out = [];
  let id = 0;
  const human = (text, at) => out.push({ type: 'user', timestamp: iso(at), sessionId: sid, ...side, message: { role: 'user', content: text } });
  const say = (text, at) => out.push({ type: 'assistant', timestamp: iso(at), sessionId: sid, ...side, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const edit = (file, line, at) => {
    const tid = `toolu_${sid}_${++id}`;
    out.push({ type: 'assistant', timestamp: iso(at), sessionId: sid, cwd: '/x', ...side, message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Edit', input: { file_path: file, old_string: 'let x;', new_string: line } }] } });
    out.push({ type: 'user', timestamp: iso(at + 1), sessionId: sid, ...side, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'updated' }] }, toolUseResult: turOf(line) });
  };
  const agent = (agentId, at) => {
    const tid = `toolu_${sid}_${++id}`;
    out.push({ type: 'assistant', timestamp: iso(at), sessionId: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Agent', input: { prompt: 'x' } }] } });
    out.push({ type: 'user', timestamp: iso(at + 1), sessionId: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: `done\nagentId: ${agentId} (use SendMessage)` }] } });
  };
  return { out, human, say, edit, agent };
}
const write = (file, entries, extra = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + extra);
};

const args = (m, o = {}) => ({
  stores: [m.store], text: LINE, side: 'R', files: [m.file], roots: [m.repo], until: Date.now(),
  home: m.home, allowDirs: [], deadline: Date.now() + 60000, ...o,
});

test('finds the latest writing edit across files and returns its excerpt', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('OLD-PROMPT fix it', 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const b = session('bbbbbbbb-2222');
  b.human('NEW-PROMPT please fix', 100); b.say('on it', 101); b.edit(m.file, LINE, 102);
  write(path.join(m.store, 'proj', 'bbbbbbbb-2222.jsonl'), b.out);
  // 줄을 말만 하고 쓰지 않은 기록 — 1차 거르기엔 걸리지만 후보가 아니다
  const c = session('cccccccc-3333');
  c.human(`talking about ${LINE} only`, 300); c.say(`maybe ${LINE}`, 301);
  write(path.join(m.store, 'proj', 'cccccccc-3333.jsonl'), c.out);

  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
  assert.equal(r.sessionId, 'bbbbbbbb-2222');
  assert.equal(r.subagent, false);
  assert.equal(r.at, T0 + 103e3);
  assert.match(r.excerpt, /NEW-PROMPT/);
  assert.match(r.excerpt, /bbbbbbbb/);
  assert.doesNotMatch(r.excerpt, /OLD-PROMPT/);
});

test('a subagent edit is labelled with the parent session and carries brief plus parent prompt', async () => {
  const m = mk();
  const parent = session('pppppppp-9999');
  parent.human('PARENT-PROMPT build the thing', 0); parent.say('dispatching', 1); parent.agent('abc123', 2);
  write(path.join(m.store, 'proj', 'pppppppp-9999.jsonl'), parent.out);
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('SUBAGENT-BRIEF implement it', 3); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);

  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
  assert.equal(r.subagent, true);
  assert.equal(r.sessionId, 'pppppppp-9999');
  assert.match(r.excerpt, /PARENT-PROMPT/);
  assert.match(r.excerpt, /SUBAGENT-BRIEF/);
  assert.match(r.excerpt, /pppppppp/);
});

test('a subagent whose parent file is missing still gives its brief', async () => {
  const m = mk();
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('SUBAGENT-BRIEF alone', 3); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
  assert.match(r.excerpt, /SUBAGENT-BRIEF/);
});

test('an edit with no human message in the last 300 records gives no-human', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('FAR-PROMPT', 0);
  for (let i = 0; i < 305; i++) a.say(`filler ${i}`, 1 + i);
  a.edit(m.file, LINE, 400);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  assert.deepEqual(await S.findAuthoring(args(m)), { found: false, reason: 'no-human' });
});

test('an excerpt that mentions a path in another project gives mixed', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human(`compare with ${path.join(m.home, 'other-project', 'x.ts')}`, 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  assert.deepEqual(await S.findAuthoring(args(m)), { found: false, reason: 'mixed' });
});

test('nothing writes the line gives not-found', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('hello', 0); a.edit(m.file, 'something else entirely;', 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  assert.deepEqual(await S.findAuthoring(args(m)), { found: false, reason: 'not-found' });
});

test('two store paths that resolve to one folder are read once', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const cfg = path.join(m.base, 'cfg');
  fs.mkdirSync(cfg);
  fs.symlinkSync(m.store, path.join(cfg, 'projects'));
  fs.mkdirSync(path.join(m.home, '.claude'), { recursive: true });
  fs.symlinkSync(m.store, path.join(m.home, '.claude', 'projects'));
  const stores = S.sessionStores({ CLAUDE_CONFIG_DIR: cfg }, m.home);
  assert.deepEqual(stores, [m.store]);
  // 저장소를 두 경로로 직접 줘도 파일은 한 번만 읽는다
  const orig = fs.promises.readFile;
  const seen = [];
  fs.promises.readFile = async (p, ...rest) => { seen.push(String(p)); return orig.call(fs.promises, p, ...rest); };
  try {
    const r = await S.findAuthoring(args(m, { stores: [m.store, path.join(cfg, 'projects')] }));
    assert.equal(r.found, true);
  } finally { fs.promises.readFile = orig; }
  assert.equal(seen.filter((p) => p.endsWith('aaaaaaaa-1111.jsonl')).length, 1);
});

test('sessionStores ignores an empty CLAUDE_CONFIG_DIR and missing folders', () => {
  const m = mk();
  assert.deepEqual(S.sessionStores({ CLAUDE_CONFIG_DIR: '' }, m.home), []);
  fs.mkdirSync(path.join(m.home, '.claude', 'projects'), { recursive: true });
  assert.deepEqual(S.sessionStores({ CLAUDE_CONFIG_DIR: '' }, m.home), [path.join(m.home, '.claude', 'projects')]);
  assert.deepEqual(S.sessionStores({ CLAUDE_CONFIG_DIR: path.join(m.base, 'nope') }, m.home), [path.join(m.home, '.claude', 'projects')]);
});

test('allowDirs lists tmp, claude config folders, and ignores an empty CLAUDE_CONFIG_DIR', () => {
  const m = mk();
  fs.mkdirSync(path.join(m.home, '.claude'), { recursive: true });
  const base = S.allowDirs({ CLAUDE_CONFIG_DIR: '' }, m.home);
  assert.ok(base.includes(path.join(m.home, '.claude')));
  assert.ok(base.includes(fs.realpathSync(os.tmpdir())));
  const cfg = path.join(m.base, 'cfg');
  fs.mkdirSync(cfg);
  assert.ok(S.allowDirs({ CLAUDE_CONFIG_DIR: cfg }, m.home).includes(cfg));
});

test('resolvePath maps a deleted file under a symlinked folder to its real location', () => {
  const m = mk();
  const link = path.join(m.base, 'link');
  fs.symlinkSync(m.repo, link);
  assert.equal(S.resolvePath(path.join(link, 'src', 'gone', 'x.ts')), path.join(m.repo, 'src', 'gone', 'x.ts'));
});

test('a past deadline gives timeout', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  assert.deepEqual(await S.findAuthoring(args(m, { deadline: Date.now() - 1 })), { found: false, reason: 'timeout' });
});

test('a short line gives short-line without reading', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, 'return;', 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const orig = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = async (...x) => { reads++; return orig.apply(fs.promises, x); };
  try {
    assert.deepEqual(await S.findAuthoring(args(m, { text: '  return;  ' })), { found: false, reason: 'short-line' });
  } finally { fs.promises.readFile = orig; }
  assert.equal(reads, 0);
});

test('a broken line in a file is skipped', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT-AFTER-BROKEN', 0); a.edit(m.file, LINE, 2);
  const file = path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl');
  write(file, a.out, '{"type":"assistant", broken ' + LINE + '\n');
  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
  assert.match(r.excerpt, /PROMPT-AFTER-BROKEN/);
});

test('an unreadable file does not stop the scan', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  fs.symlinkSync(path.join(m.base, 'does-not-exist'), path.join(m.store, 'proj', 'dangling.jsonl'));
  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
});

test('an edit made through a symlinked path counts as the same file (same resolver for judging and excerpt)', async () => {
  const m = mk();
  const link = path.join(m.base, 'link');
  fs.symlinkSync(m.repo, link);
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(path.join(link, 'src', 'a.ts'), LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
});

// ---- fix round 1 ----
const readTool = (sess, file, content, at) => {
  const tid = `toolu_read_${at}`;
  sess.out.push({ type: 'assistant', timestamp: iso(at), sessionId: sess.out[0].sessionId, cwd: '/x', message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Read', input: { file_path: file } }] } });
  sess.out.push({ type: 'user', timestamp: iso(at + 1), sessionId: sess.out[0].sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content }] } });
};
const withReads = async (fn) => {
  const orig = fs.promises.readFile;
  try { return await fn(orig); } finally { fs.promises.readFile = orig; }
};

test('F1 a Read through an in-repo symlink to another project never reaches the excerpt', async () => {
  const m = mk();
  const other = path.join(m.home, 'company-repo');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'secret.txt'), 'x');
  fs.symlinkSync(path.join(other, 'secret.txt'), path.join(m.repo, 'src', 'evil.txt'));
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0);
  readTool(a, path.join(m.repo, 'src', 'evil.txt'), 'TOP-SECRET-OTHER-PROJECT-CONTENT', 1);
  a.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const r = await S.findAuthoring(args(m));
  assert.ok(r.found === false || !r.excerpt.includes('TOP-SECRET-OTHER-PROJECT-CONTENT'));
  assert.equal(r.found, true);
  assert.doesNotMatch(r.excerpt, /evil\.txt/);
});

test('F2 a parent human prompt that names another project makes the subagent excerpt mixed', async () => {
  const m = mk();
  const parent = session('pppppppp-9999');
  parent.human(`look at ${path.join(m.home, 'company-repo', '.env')} too`, 0); parent.agent('abc123', 2);
  write(path.join(m.store, 'proj', 'pppppppp-9999.jsonl'), parent.out);
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('BRIEF', 3); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  assert.deepEqual(await S.findAuthoring(args(m)), { found: false, reason: 'mixed' });
});

test('F3 a subagent edit that comes before its brief gives no-human, not an empty excerpt', async () => {
  const m = mk();
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.edit(m.file, LINE, 1); sub.human('LATE-BRIEF', 9);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  assert.deepEqual(await S.findAuthoring(args(m)), { found: false, reason: 'no-human' });
  const none = session('pppppppp-8888', { sidechain: true });
  none.edit(m.file, LINE, 1);
  fs.rmSync(path.join(m.store, 'proj', 'pppppppp-9999'), { recursive: true });
  write(path.join(m.store, 'proj', 'pppppppp-8888', 'subagents', 'agent-abc123.jsonl'), none.out);
  assert.deepEqual(await S.findAuthoring(args(m)), { found: false, reason: 'no-human' });
});

test('F4 a symlinked alias folder does not link a subagent to the wrong parent', async () => {
  const m = mk();
  const real = session('real-parent');
  real.human('REAL-PARENT-PROMPT', 0); real.agent('abc123', 2);
  write(path.join(m.store, 'proj', 'real-parent.jsonl'), real.out);
  const decoy = session('alias-parent');
  decoy.human('DECOY-PROMPT', 0); decoy.agent('abc123', 2);
  write(path.join(m.store, 'proj', 'alias-parent.jsonl'), decoy.out);
  const sub = session('real-parent', { sidechain: true });
  sub.human('BRIEF', 3); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'real-parent', 'subagents', 'agent-abc123.jsonl'), sub.out);
  fs.symlinkSync(path.join(m.store, 'proj', 'real-parent'), path.join(m.store, 'proj', 'alias-parent'));
  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
  assert.equal(r.sessionId, 'real-parent');
  assert.match(r.excerpt, /REAL-PARENT-PROMPT/);
  assert.doesNotMatch(r.excerpt, /DECOY-PROMPT/);
});

test('F4 a parent whose entries carry another session id is not trusted', async () => {
  const m = mk();
  const parent = session('some-other-session');
  parent.human('WRONG-PARENT-PROMPT', 0); parent.agent('abc123', 2);
  write(path.join(m.store, 'proj', 'pppppppp-9999.jsonl'), parent.out);
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('BRIEF', 3); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
  assert.doesNotMatch(r.excerpt, /WRONG-PARENT-PROMPT/);
});

test('F5 a deadline passed mid-scan or right after the last file gives timeout', async () => {
  const m = mk();
  for (const sid of ['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3']) {
    const a = session(sid);
    a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
    write(path.join(m.store, 'proj', `${sid}.jsonl`), a.out);
  }
  for (const [label, keep] of [['mid-scan', 3], ['after last', 1]]) {
    if (label === 'after last') for (const sid of ['bbbbbbbb-2', 'cccccccc-3']) fs.rmSync(path.join(m.store, 'proj', `${sid}.jsonl`));
    let t = 1000;
    const r = await withReads(async (orig) => {
      let n = 0;
      fs.promises.readFile = async (...x) => { const b = await orig.apply(fs.promises, x); if (++n >= 1) t = 5000; return b; };
      return S.findAuthoring(args(m, { now: () => t, deadline: 2000 }));
    });
    assert.deepEqual(r, { found: false, reason: 'timeout' }, `${label} ${keep}`);
  }
});

test('F5 an unreadable file is skipped without throwing', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const bad = path.join(m.store, 'proj', 'zzzz-locked.jsonl');
  fs.writeFileSync(bad, LINE);
  fs.chmodSync(bad, 0);
  try { assert.equal((await S.findAuthoring(args(m))).found, true); } finally { fs.chmodSync(bad, 0o600); }
});

test('F5 the deadline is checked while collecting files', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  let calls = 0;
  // 첫 확인(시작)은 통과, 그 뒤로는 마감 지남 — 수집 중에 걸려야 한다
  const r = await S.findAuthoring(args(m, { deadline: 2000, now: () => (++calls <= 1 ? 1000 : 5000) }));
  assert.deepEqual(r, { found: false, reason: 'timeout' });
});

test('F6 files over the size cap are skipped and counted, not read', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const stats = {};
  const r = await S.findAuthoring(args(m, { maxFileBytes: 10, stats }));
  assert.deepEqual(r, { found: false, reason: 'not-found' });
  assert.equal(stats.skipped, 1);
  // 기본 상한: 희소 파일 65MiB 는 읽지 않는다
  const big = path.join(m.store, 'proj', 'big.jsonl');
  fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, 65 * 1024 * 1024);
  const st2 = {};
  let bigReads = 0;
  await withReads(async (orig) => {
    fs.promises.readFile = async (p, ...x) => { if (String(p) === big) bigReads++; return orig.call(fs.promises, p, ...x); };
    assert.equal((await S.findAuthoring(args(m, { stats: st2 }))).found, true);
  });
  assert.equal(bigReads, 0);
  assert.equal(st2.skipped, 1);
});

test('F6 at most 4 files are read at once', async () => {
  const m = mk();
  for (let i = 0; i < 12; i++) write(path.join(m.store, 'proj', `s${i}.jsonl`), [{ type: 'user', message: { content: 'x' } }]);
  let live = 0;
  let peak = 0;
  await withReads(async (orig) => {
    fs.promises.readFile = async (...x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); try { return await orig.apply(fs.promises, x); } finally { live--; } };
    await S.findAuthoring(args(m));
  });
  assert.ok(peak >= 2 && peak <= 4, `peak ${peak}`);
});

test('F7 a file reached by a symlink to it and by its (symlinked-store) path is read once', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
  const f = path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl');
  write(f, a.out);
  const viaLink = path.join(m.base, 'storelink');
  fs.symlinkSync(m.store, viaLink);
  fs.symlinkSync(f, path.join(m.store, 'proj', 'a-alias.jsonl'));   // 실제 경로를 가리키는 링크
  const seen = [];
  await withReads(async (orig) => {
    fs.promises.readFile = async (p, ...x) => { seen.push(String(p)); return orig.call(fs.promises, p, ...x); };
    await S.findAuthoring(args(m, { stores: [viaLink] }));
  });
  assert.equal(seen.length, 1);
});

test('F7 equal times are broken by realpath ascending, whatever finishes first', async () => {
  const m = mk();
  for (const sid of ['aaaaaaaa-1', 'bbbbbbbb-2']) {
    const a = session(sid);
    a.human(`PROMPT-${sid}`, 0); a.edit(m.file, LINE, 2);
    write(path.join(m.store, 'proj', `${sid}.jsonl`), a.out);
  }
  const r = await withReads(async (orig) => {
    fs.promises.readFile = async (p, ...x) => { if (String(p).includes('aaaaaaaa')) await new Promise((k) => setTimeout(k, 60)); return orig.call(fs.promises, p, ...x); };
    return S.findAuthoring(args(m));
  });
  assert.equal(r.sessionId, 'aaaaaaaa-1');
});

test('F4 a subagent whose own entries name another session is not tied to the folder parent', async () => {
  const m = mk();
  const parent = session('pppppppp-9999');
  parent.human('FOLDER-PARENT-PROMPT', 0); parent.agent('abc123', 2);
  write(path.join(m.store, 'proj', 'pppppppp-9999.jsonl'), parent.out);
  const sub = session('other-sub-session', { sidechain: true });
  sub.human('BRIEF', 3); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
  assert.equal(r.sessionId, 'other-sub-session');
  assert.doesNotMatch(r.excerpt, /FOLDER-PARENT-PROMPT/);
});

test('F5 a deadline that passes while the parent file is being read gives timeout', async () => {
  const m = mk();
  const parent = session('pppppppp-9999');
  parent.human('PARENT', 0); parent.agent('abc123', 2);
  write(path.join(m.store, 'proj', 'pppppppp-9999.jsonl'), parent.out);
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('BRIEF', 3); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  let t = 1000;
  const r = await withReads(async (orig) => {
    fs.promises.readFile = async (p, ...x) => { const b = await orig.call(fs.promises, p, ...x); if (String(p).endsWith('pppppppp-9999.jsonl')) t = 5000; return b; };
    return S.findAuthoring(args(m, { now: () => t, deadline: 2000 }));
  });
  assert.deepEqual(r, { found: false, reason: 'timeout' });
});
