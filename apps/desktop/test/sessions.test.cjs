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
  // 입력과 결과 패치를 따로 정한다 — 입력에 그 줄 글이 없어도 되는 편집(부분 줄 치환·Write 갱신)을 흉내 낸다
  const use = (name, input, tur, at, o = {}) => {
    const tid = `toolu_${sid}_${++id}`;
    out.push({ type: 'assistant', timestamp: iso(at), sessionId: sid, cwd: '/x', ...side, message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input }] } });
    out.push({ type: 'user', timestamp: iso(at + 1), sessionId: sid, ...side, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: o.big || 'updated' }] }, toolUseResult: tur });
  };
  const agent = (agentId, at) => {
    const tid = `toolu_${sid}_${++id}`;
    out.push({ type: 'assistant', timestamp: iso(at), sessionId: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Agent', input: { prompt: 'x' } }] } });
    out.push({ type: 'user', timestamp: iso(at + 1), sessionId: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: `done\nagentId: ${agentId} (use SendMessage)` }] } });
  };
  return { out, human, say, edit, agent, use };
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
  const seen = [];
  await withOpen({ onOpen: (p) => { seen.push(p); } }, async () => {
    const r = await S.findAuthoring(args(m, { stores: [m.store, path.join(cfg, 'projects')] }));
    assert.equal(r.found, true);
  });
  // 훑기는 파일마다 거르기 1번 + 후보 파일 1번 읽는다 — 같은 파일이 두 경로로 두 번 읽히면 4번이 된다
  assert.equal(new Set(seen.filter((p) => p.endsWith('aaaaaaaa-1111.jsonl'))).size, 1);
  assert.ok(seen.filter((p) => p.endsWith('aaaaaaaa-1111.jsonl')).length <= 4);
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
  let reads = 0;
  await withOpen({ onOpen: () => { reads++; } }, async () => {
    assert.deepEqual(await S.findAuthoring(args(m, { text: '  return;  ' })), { found: false, reason: 'short-line' });
  });
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
// 파일을 여는/닫는 순간에 끼어든다 — 기록 읽기는 fs.promises.open 으로만 한다(스트리밍)
const withOpen = async ({ onOpen, onClose } = {}, fn) => {
  const orig = fs.promises.open;
  fs.promises.open = async (p, ...x) => {
    if (onOpen) await onOpen(String(p));
    const fh = await orig.call(fs.promises, p, ...x);
    const close = fh.close.bind(fh);
    fh.close = async () => { try { return await close(); } finally { if (onClose) await onClose(String(p)); } };
    return fh;
  };
  try { return await fn(); } finally { fs.promises.open = orig; }
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
  let t = 1000;
  // 첫 파일을 연 뒤 시계가 마감을 넘는다
  let r = await withOpen({ onOpen: () => { t = 5000; } }, () => S.findAuthoring(args(m, { now: () => t, deadline: 2000 })));
  assert.deepEqual(r, { found: false, reason: 'timeout' }, 'mid-scan');
  for (const sid of ['bbbbbbbb-2', 'cccccccc-3']) fs.rmSync(path.join(m.store, 'proj', `${sid}.jsonl`));
  t = 1000;
  // 마지막 파일을 다 읽고 닫는 순간 마감을 넘는다(읽기 중에는 아직 아님)
  r = await withOpen({ onClose: () => { t = 5000; } }, () => S.findAuthoring(args(m, { now: () => t, deadline: 2000 })));
  assert.deepEqual(r, { found: false, reason: 'timeout' }, 'after last');
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

test('F6 at most 4 files are open at once', async () => {
  const m = mk();
  for (let i = 0; i < 12; i++) write(path.join(m.store, 'proj', `s${i}.jsonl`), [{ type: 'user', message: { content: 'x' } }]);
  let live = 0;
  let peak = 0;
  await withOpen({ onOpen: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); }, onClose: () => { live--; } },
    () => S.findAuthoring(args(m)));
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
  await withOpen({ onOpen: (p) => { seen.push(p); } }, () => S.findAuthoring(args(m, { stores: [viaLink] })));
  assert.equal(new Set(seen.map((x) => fs.realpathSync(x))).size, 1);   // 한 파일(실제 경로)만 연다
  assert.ok(seen.length <= 4);           // 거르기 + 판정 + 줄 훑기 + 범위 읽기 — 같은 파일이 두 번 닿았다면 8
});

test('F7 equal times are broken by realpath ascending, whatever finishes first', async () => {
  const m = mk();
  for (const sid of ['aaaaaaaa-1', 'bbbbbbbb-2']) {
    const a = session(sid);
    a.human(`PROMPT-${sid}`, 0); a.edit(m.file, LINE, 2);
    write(path.join(m.store, 'proj', `${sid}.jsonl`), a.out);
  }
  const r = await withOpen({ onOpen: async (p) => { if (p.includes('aaaaaaaa')) await new Promise((k) => setTimeout(k, 60)); } }, () => S.findAuthoring(args(m)));
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
  let parentOpens = 0;   // 첫 번째는 훑기의 거르기, 두 번째가 부모 읽기
  const r = await withOpen({ onOpen: (p) => { if (p.endsWith(`${path.sep}pppppppp-9999.jsonl`) && ++parentOpens === 2) t = 5000; } }, () => S.findAuthoring(args(m, { now: () => t, deadline: 2000 })));
  assert.equal(parentOpens, 2);
  assert.deepEqual(r, { found: false, reason: 'timeout' });
});

// ---- fix round 2: bounded-memory streaming ----
const filler = (sess, n, at0, text = 'filler') => { for (let i = 0; i < n; i++) sess.say(`${text} ${i}`, at0 + i); };
const SMALL = { chunkBytes: 256, lineMax: 4096, windowLineMax: 2048 };

test('P7 the newest writer wins even when its file is big (no size skipping)', async () => {
  const m = mk();
  const old = session('aaaaaaaa-1111');
  old.human('OLD-PROMPT', 0); old.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), old.out);
  const neu = session('bbbbbbbb-2222');
  filler(neu, 400, 0);
  neu.human('NEW-PROMPT', 1000); neu.edit(m.file, LINE, 1002);
  filler(neu, 3000, 1100);
  const f = path.join(m.store, 'proj', 'bbbbbbbb-2222.jsonl');
  write(f, neu.out);
  assert.ok(fs.statSync(f).size > 200000);
  const stats = {};
  const r = await S.findAuthoring(args(m, { ...SMALL, stats }));
  assert.equal(r.found, true);
  assert.equal(r.sessionId, 'bbbbbbbb-2222');
  assert.match(r.excerpt, /NEW-PROMPT/);
  assert.doesNotMatch(r.excerpt, /OLD-PROMPT/);
  // 메모리: 한 번에 잡는 버퍼가 파일 크기에 비례하지 않는다
  assert.ok(stats.peakBytes < fs.statSync(f).size / 3, `peak ${stats.peakBytes}`);
});

test('a needle that straddles a chunk boundary is found at every offset', async () => {
  const m = mk();
  for (let pad = 0; pad < 40; pad += 7) {
    const a = session('aaaaaaaa-1111');
    a.human('PROMPT', 0); a.say('x'.repeat(pad), 1); a.edit(m.file, LINE, 2);
    write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
    for (const chunkBytes of [64, 97, 128]) {
      const r = await S.findAuthoring(args(m, { chunkBytes, lineMax: 1 << 20, windowLineMax: 1 << 20 }));
      assert.equal(r.found, true, `pad ${pad} chunk ${chunkBytes}`);
    }
  }
});

test('a parent bigger than any window is still linked, with bounded memory', async () => {
  const m = mk();
  const parent = session('pppppppp-9999');
  filler(parent, 300, 0);
  parent.human('PARENT-PROMPT', 400); parent.agent('abc123', 402);
  filler(parent, 3000, 500);
  const pf = path.join(m.store, 'proj', 'pppppppp-9999.jsonl');
  write(pf, parent.out);
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('BRIEF', 403); sub.edit(m.file, LINE, 405);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  const stats = {};
  const r = await S.findAuthoring(args(m, { ...SMALL, stats }));
  assert.equal(r.found, true);
  assert.equal(r.subagent, true);
  assert.match(r.excerpt, /PARENT-PROMPT/);
  assert.ok(stats.peakBytes < fs.statSync(pf).size / 3, `peak ${stats.peakBytes}`);
});

test('a line over windowLineMax in the excerpt window gives mixed', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.say('y'.repeat(3000), 1); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  assert.deepEqual(await S.findAuthoring(args(m, SMALL)), { found: false, reason: 'mixed' });
});

test('a needle line over lineMax gives unreadable', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.say(`${'z'.repeat(5000)} ${LINE}`, 1);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  assert.deepEqual(await S.findAuthoring(args(m, SMALL)), { found: false, reason: 'unreadable' });
  // 같은 길이라도 줄이 안 들어 있으면 그냥 못 찾은 것
  const b = session('bbbbbbbb-2222');
  b.human('PROMPT', 0); b.say('z'.repeat(5000), 1);
  fs.rmSync(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'));
  write(path.join(m.store, 'proj', 'bbbbbbbb-2222.jsonl'), b.out);
  assert.deepEqual(await S.findAuthoring(args(m, SMALL)), { found: false, reason: 'not-found' });
});

test('a subagent id comes from the real path, not the alias it was reached by', async () => {
  const m = mk();
  const real = session('real-parent');
  real.human('REAL-PARENT-PROMPT', 0); real.agent('abc123', 2);
  write(path.join(m.store, 'proj', 'real-parent.jsonl'), real.out);
  const sub = session('real-parent', { sidechain: true });
  sub.human('BRIEF', 3); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'real-parent', 'subagents', 'agent-abc123.jsonl'), sub.out);
  const alias = path.join(m.base, 'alias-file.jsonl');   // 구조가 다른 이름의 링크로 닿아도
  fs.symlinkSync(path.join(m.store, 'proj', 'real-parent', 'subagents', 'agent-abc123.jsonl'), alias);
  const linkStore = path.join(m.base, 'linkstore');
  fs.mkdirSync(linkStore);
  fs.symlinkSync(alias, path.join(linkStore, 'x.jsonl'));
  const r = await S.findAuthoring(args(m, { stores: [linkStore] }));
  assert.equal(r.found, true);
  assert.equal(r.subagent, true);
  assert.match(r.excerpt, /REAL-PARENT-PROMPT/);
});

test('a needle that straddles a chunk boundary in every occurrence is still found (the cheap pre-pass handles it)', async () => {
  const m = mk();
  const build = (pad) => {
    const a = session('aaaaaaaa-1111');
    a.human('PROMPT', 0); a.say('x'.repeat(pad), 1); a.edit(m.file, LINE, 2);
    return a.out.map((e) => JSON.stringify(e)).join('\n') + '\n';
  };
  const at = (buf, from) => Buffer.from(buf).indexOf(LINE, from);
  const t0 = build(0);
  const x0 = at(t0, 0);
  const d = at(t0, x0 + 1) - x0;   // 같은 줄이 다시 나오는 곳까지(편집 입력 → 결과 패치)
  assert.ok(d > LINE.length + 1);
  const pad = ((d - 10 - (x0 % d)) % d + d) % d;
  const file = path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl');
  fs.writeFileSync(file, build(pad));
  const raw = fs.readFileSync(file);
  assert.equal((at(raw, 0) % d), d - 10);   // 첫 등장이 청크 경계(d 의 배수)를 가른다
  const r = await S.findAuthoring(args(m, { chunkBytes: d, lineMax: 1 << 20, windowLineMax: 1 << 20 }));
  assert.equal(r.found, true);
});

test('a window over windowTotalMax gives mixed', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PROMPT', 0); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  assert.deepEqual(await S.findAuthoring(args(m, { windowTotalMax: 50 })), { found: false, reason: 'mixed' });
});

test('an unreadable first user line means no brief is guessed from a later one', async () => {
  const m = mk();
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('B'.repeat(5000), 3); sub.human('SECOND-USER-LINE', 4); sub.edit(m.file, LINE, 5);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  assert.deepEqual(await S.findAuthoring(args(m, { ...SMALL, windowLineMax: 100000 })), { found: false, reason: 'no-human' });
});

test('an unreadable spawn result in the parent does not let a later mention pick another prompt', async () => {
  const m = mk();
  const parent = session('pppppppp-9999');
  parent.human('HUMAN-ONE', 0);
  const tid = 'toolu_big';
  parent.out.push({ type: 'assistant', timestamp: iso(1), sessionId: 'pppppppp-9999', message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Agent', input: { prompt: 'x' } }] } });
  parent.out.push({ type: 'user', timestamp: iso(2), sessionId: 'pppppppp-9999', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: `${'q'.repeat(5000)}\nagentId: abc123 (x)` }] } });
  parent.human('HUMAN-TWO', 3); parent.agent('abc123', 4);   // 다시 언급한 호출
  write(path.join(m.store, 'proj', 'pppppppp-9999.jsonl'), parent.out);
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('BRIEF', 5); sub.edit(m.file, LINE, 7);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  const r = await S.findAuthoring(args(m, { ...SMALL, windowLineMax: 100000 }));
  assert.equal(r.found, true);
  assert.doesNotMatch(r.excerpt, /HUMAN-/);
});

// ---- fix round 3: pairing by id, not by needle ----
const patch = (...lines) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }];
const partial = (a, file, at) => a.use('Edit', { file_path: file, old_string: 'answer = 0;', new_string: 'answer = compute();' },
  { originalFile: 'x', structuredPatch: patch('-const answer = 0;', `+${LINE}`) }, at);

test('P1 a partial-line Edit (the input lacks the full line) is the writer', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('PARTIAL-PROMPT', 0); partial(a, m.file, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const r = await S.findAuthoring(args(m));
  assert.equal(r.found, true);
  assert.match(r.excerpt, /PARTIAL-PROMPT/);
});

test('P2 an older full-line writer loses to a newer partial-line writer', async () => {
  const m = mk();
  const old = session('aaaaaaaa-1111');
  old.human('OLD-PROMPT', 0); old.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), old.out);
  const neu = session('bbbbbbbb-2222');
  neu.human('NEW-PROMPT', 100); partial(neu, m.file, 102);
  write(path.join(m.store, 'proj', 'bbbbbbbb-2222.jsonl'), neu.out);
  const r = await S.findAuthoring(args(m));
  assert.equal(r.sessionId, 'bbbbbbbb-2222');
  assert.doesNotMatch(r.excerpt, /OLD-PROMPT/);
});

test('P3 an L-side Write update whose content no longer holds the deleted line is the writer', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('L-WRITE-PROMPT', 0);
  a.use('Write', { file_path: m.file, content: 'something else entirely\n' },
    { type: 'update', content: 'something else entirely\n', originalFile: `${LINE}\n`, structuredPatch: patch(`-${LINE}`, '+something else entirely') }, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const r = await S.findAuthoring(args(m, { side: 'L' }));
  assert.equal(r.found, true);
  assert.match(r.excerpt, /L-WRITE-PROMPT/);
});

test('P4 an L-side partial Edit is the writer', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.human('L-EDIT-PROMPT', 0);
  a.use('Edit', { file_path: m.file, old_string: 'compute();', new_string: '1;' },
    { originalFile: 'x', structuredPatch: patch(`-${LINE}`, '+const answer = 1;') }, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const r = await S.findAuthoring(args(m, { side: 'L' }));
  assert.equal(r.found, true);
});

test('N2 kept state stays small when many Edit results carry a big originalFile that holds the line', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  const bigFile = `${LINE}\n`.repeat(Math.ceil(200 * 1024 / (LINE.length + 1)));
  for (let i = 0; i < 200; i++) {
    a.use('Edit', { file_path: m.file, old_string: `v${i}`, new_string: `w${i}` },
      { originalFile: bigFile, structuredPatch: patch(`-v${i}`, `+w${i}`) }, 1 + i * 2);
  }
  a.human('PROMPT', 999); a.edit(m.file, LINE, 1000);
  const f = path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl');
  write(f, a.out);
  assert.ok(fs.statSync(f).size > 30 * 1024 * 1024);
  const stats = {};
  const r = await S.findAuthoring(args(m, { stats }));
  assert.equal(r.found, true);
  assert.ok(stats.keptBytes > 0 && stats.keptBytes <= 64 * 1024, `kept ${stats.keptBytes}`);
});

test('M1 an oversize line older than the human prompt no longer fails the window; one after it still does', async () => {
  const m = mk();
  const a = session('aaaaaaaa-1111');
  a.say('y'.repeat(3000), 0); a.human('PROMPT-AFTER-BIG', 1); a.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), a.out);
  const r = await S.findAuthoring(args(m, SMALL));
  assert.equal(r.found, true);
  assert.match(r.excerpt, /PROMPT-AFTER-BIG/);
  const b = session('aaaaaaaa-1111');
  b.human('PROMPT', 0); b.say('y'.repeat(3000), 1); b.edit(m.file, LINE, 2);
  write(path.join(m.store, 'proj', 'aaaaaaaa-1111.jsonl'), b.out);
  assert.deepEqual(await S.findAuthoring(args(m, SMALL)), { found: false, reason: 'mixed' });
});

test('M1 parent: a long line before the human prompt is ignored, one after it drops the prompt', async () => {
  const m = mk();
  const mkParent = (bigBefore) => {
    const parent = session('pppppppp-9999');
    if (bigBefore) parent.say('y'.repeat(3000), 0);
    parent.human('PARENT-PROMPT', 1);
    if (!bigBefore) parent.say('y'.repeat(3000), 2);
    parent.agent('abc123', 3);
    write(path.join(m.store, 'proj', 'pppppppp-9999.jsonl'), parent.out);
  };
  const sub = session('pppppppp-9999', { sidechain: true });
  sub.human('BRIEF', 5); sub.edit(m.file, LINE, 7);
  write(path.join(m.store, 'proj', 'pppppppp-9999', 'subagents', 'agent-abc123.jsonl'), sub.out);
  mkParent(true);
  assert.match((await S.findAuthoring(args(m, SMALL))).excerpt, /PARENT-PROMPT/);
  mkParent(false);
  assert.doesNotMatch((await S.findAuthoring(args(m, SMALL))).excerpt, /PARENT-PROMPT/);
});
