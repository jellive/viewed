const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../ask/transcripts.cjs');

const T0 = Date.parse('2026-10-15T05:00:00.000Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const LATER = T0 + 3600e3;
const R = '/home/u/viewed';
const F = `${R}/src/a.ts`;
const LINE = 'const answer = compute();';
const CTX = { roots: [R], home: '/home/u', allowDirs: ['/home/u/.claude', '/tmp'] };

// 줄 diff 를 흉내 낸 structuredPatch — 앞뒤 같은 줄은 문맥(' '), 가운데만 '-'/'+'
function patchOf(old, neu) {
  const a = old.split('\n');
  const b = neu.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const lines = [...a.slice(0, p).map((l) => ` ${l}`), ...a.slice(p, a.length - s).map((l) => `-${l}`),
    ...b.slice(p, b.length - s).map((l) => `+${l}`), ...a.slice(a.length - s).map((l) => ` ${l}`)];
  return [{ oldStart: 1, oldLines: a.length, newStart: 1, newLines: b.length, lines }];
}
const editTur = (old, neu, structuredPatch = patchOf(old, neu)) => ({ originalFile: old, structuredPatch, userModified: false, replaceAll: false });
const writeTur = (type, content, originalFile = null) => ({ type, content, originalFile, structuredPatch: type === 'create' ? [] : patchOf(originalFile, content) });

// 합성 세션 기록 — Claude Code 2.1.x 에서 본 모양만 흉내 낸다(실제 ~/.claude 기록은 읽지 않는다).
// at 은 T0 기준 초. 안 주면 기록마다 1초씩 늘어난다. o.tur: 결과 기록의 toolUseResult(null 이면 없음), o.resultTs: 결과 시각 덮어쓰기(null 이면 없음)
function tx() {
  const entries = [];
  let clock = 0;
  let ids = 0;
  const push = (e) => { entries.push(e); return entries.length - 1; };
  const when = (o) => iso(o && o.at !== undefined ? o.at : ++clock);
  const side = (o) => (o && o.sidechain ? { isSidechain: true } : {});
  const result = (id, out, o) => {
    const ts = o.resultTs !== undefined ? o.resultTs : when(o);
    return push({
      type: 'user', ...(ts === null ? {} : { timestamp: ts }), sessionId: 'sess-1', ...side(o),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out, ...(o.err ? { is_error: true } : {}) }] },
      ...(o.tur !== undefined && o.tur !== null ? { toolUseResult: o.tur } : {}),
    });
  };
  function tool(name, input, out, o = {}) {
    const id = `toolu_${++ids}`;
    const i = push({
      type: 'assistant', timestamp: when(o), sessionId: 'sess-1', cwd: o.cwd || '/home/u/work', ...side(o),
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
    if (out !== undefined) result(id, out, o);
    return i;
  }
  // 실패한 편집에도 '그 줄을 더한' 패치를 붙인다 — 오류 표시만으로 빠지는지 보려고
  const edit = (file, old, neu, o = {}) => tool('Edit', { file_path: file, old_string: old, new_string: neu },
    o.err ? '<tool_use_error>String to replace not found in file.</tool_use_error>' : 'The file has been updated.',
    { ...o, tur: o.tur !== undefined ? o.tur : editTur(old, neu) });
  const human = (text, o = {}) => push({
    type: 'user', timestamp: when(o), sessionId: 'sess-1', ...side(o), ...(o.meta ? { isMeta: true } : {}),
    message: { role: 'user', content: o.array ? [{ type: 'text', text }] : text },
  });
  const assistant = (item, o = {}) => push({
    type: 'assistant', timestamp: when(o), sessionId: 'sess-1', cwd: '/home/u/work', ...side(o),
    message: { role: 'assistant', content: [item] },
  });
  const say = (text, o) => assistant({ type: 'text', text }, o);
  const think = (thinking, o) => assistant({ type: 'thinking', thinking, signature: 'sig' }, o);
  const idAt = (i) => entries[i].message.content[0].id;
  return { entries, tool, edit, human, say, think, idAt };
}

const q = (o = {}) => ({ text: LINE, side: 'R', files: [F], until: LATER, ...o });

test('a sibling repo with a shared name prefix is not this repo', () => {
  const t = tx();
  t.human('고쳐줘');
  t.edit('/home/u/viewed-company/src/a.ts', 'let x;', LINE);
  assert.equal(T.findWrite(t.entries, q()), null);
  assert.equal(T.insideAny('/home/u/viewed-company/x', ['/home/u/viewed']), false);
  assert.equal(T.insideAny('/home/u/viewed/x', ['/home/u/viewed']), true);
  assert.equal(T.insideAny('/home/u/viewed', ['/home/u/viewed/']), true);
  assert.equal(T.insideAny('/home/u/viewed/../other/x', ['/home/u/viewed']), false);
  assert.equal(T.insideAny('src/x', ['/home/u/viewed']), false);
  // 같은 편집이 이 레포에 있으면 그걸 고른다
  const mine = t.edit(F, 'let x;', LINE);
  assert.equal(T.findWrite(t.entries, q()).index, mine);
});

test('only a successful edit that wrote the line counts', () => {
  const t = tx();
  t.human('줄을 추가해');
  const good = t.edit(F, 'let x = 1;', `let x = 1;\n    ${LINE}  `);   // 들여쓰기·끝 공백은 trim 해서 본다
  t.tool('Grep', { pattern: LINE, path: R }, `src/a.ts:2:${LINE}`);
  t.tool('Bash', { command: `printf '%s\\n' '${LINE}' >> ${F}` }, '');
  t.edit(F, 'nothing here', LINE, { err: true });                                   // 실패한 Edit
  t.tool('Edit', { file_path: F, old_string: 'zzz', new_string: LINE }, '<tool_use_error>File has not been read yet.</tool_use_error>',
    { tur: editTur('zzz', LINE) });                                                    // 플래그 없는 오류 결과
  t.edit(F, `${LINE}\nfoo();`, `${LINE}\nbar();`);                                  // 그 줄을 문맥으로만 품은 이웃
  t.edit(F, 'const answer = compute(1);', 'const answer = compute(2);');            // 비슷하기만 한 줄
  t.edit(F, 'z();', `// ${LINE} 는 지웠다`);                                         // 그 줄을 부분 문자열로만 품은 줄
  t.tool('Edit', { file_path: F, old_string: 'yyy', new_string: LINE }, undefined); // 결과가 없다(중단)
  const r = T.findWrite(t.entries, q());
  assert.equal(r.index, good);
  assert.equal(r.toolUseId, t.idAt(good));
  assert.equal(r.at, Date.parse(t.entries[good + 1].timestamp));   // 편집이 끝난(결과) 시각
  // 공백 제외 8자 미만 줄은 찾지 않는다
  const s = tx();
  s.edit(F, 'a', 'return;');
  assert.equal(T.findWrite(s.entries, q({ text: 'return;' })), null);
  assert.equal(T.findWrite(s.entries, q({ text: '   }   ' })), null);
});

test('edits after the commit time are ignored and the latest earlier one wins', () => {
  const t = tx();
  const early = t.edit(F, 'a', LINE, { at: 10 });
  const mid = t.edit(F, 'b', LINE, { at: 20 });
  t.edit(F, 'c', LINE, { at: 40 });
  assert.equal(T.findWrite(t.entries, q({ until: T0 + 30_000 })).index, mid);
  assert.equal(T.findWrite(t.entries, q({ until: T0 + 20_000 })).index, mid);   // 같은 시각은 든다
  assert.equal(T.findWrite(t.entries, q({ until: T0 + 15_000 })).index, early);
  assert.equal(T.findWrite(t.entries, q({ until: T0 + 5_000 })), null);
});

test('a result without a usable timestamp is not a candidate', () => {
  for (const resultTs of ['invalid', null]) {
    const t = tx();
    t.edit(F, 'a();', LINE, { resultTs });   // tool_use 시각은 멀쩡해도 결과 시각이 없으면 후보가 아니다
    assert.equal(T.findWrite(t.entries, q()), null, String(resultTs));
  }
  // 결과 시각이 기준 시각을 넘으면, tool_use 가 그 전이어도 빠진다
  const t = tx();
  t.edit(F, 'a();', LINE, { at: 10, resultTs: iso(40) });
  assert.equal(T.findWrite(t.entries, q({ until: T0 + 30_000 })), null);
  assert.equal(T.findWrite(t.entries, q({ until: T0 + 40_000 })).at, T0 + 40_000);
});

test('a deleted line is found through a removed patch line', () => {
  const t = tx();
  const removed = t.edit(F, `keep();\n${LINE}`, 'keep();', { at: 10 });
  t.edit(F, 'other();', LINE, { at: 20 });   // 나중에 다시 넣은 편집은 R 쪽 후보일 뿐
  t.edit(F, `${LINE}\nx();`, `${LINE}\ny();`, { at: 30 });
  assert.equal(T.findWrite(t.entries, q({ side: 'L' })).index, removed);
  assert.notEqual(T.findWrite(t.entries, q({ side: 'R' })).index, removed);
});

test('MultiEdit and Write count', () => {
  const m = tx();
  const multi = m.tool('MultiEdit', { file_path: F, edits: [{ old_string: 'a();', new_string: 'b();' }, { old_string: 'c();', new_string: `c();\n${LINE}` }] },
    'Applied 2 edits.', { tur: editTur('a();\nc();', `b();\nc();\n${LINE}`) });
  assert.equal(T.findWrite(m.entries, q()).index, multi);
  const ml = tx();
  const multiDel = ml.tool('MultiEdit', { file_path: F, edits: [{ old_string: 'a();', new_string: 'b();' }, { old_string: `${LINE}\n`, new_string: '' }] },
    'Applied 2 edits.', { tur: editTur(`a();\n${LINE}\nz();`, 'b();\nz();') });
  assert.equal(T.findWrite(ml.entries, q({ side: 'L' })).index, multiDel);
  const w = tx();
  const content = `import x;\n${LINE}\n`;
  const create = w.tool('Write', { file_path: F, content }, 'File created successfully.', { tur: writeTur('create', content) });
  w.tool('Write', { file_path: `${R}/src/b.ts`, content: `${LINE}\n` }, 'File created successfully.', { at: 99, tur: writeTur('create', `${LINE}\n`) });   // 다른 파일
  assert.equal(T.findWrite(w.entries, q()).index, create);
  assert.equal(T.findWrite(w.entries, q({ side: 'L' })), null);
  const u = tx();
  const update = u.tool('Write', { file_path: F, content }, 'File updated.', { tur: writeTur('update', content, 'import x;\n') });
  assert.equal(T.findWrite(u.entries, q()).index, update);
});

test('a line counts only when the recorded patch adds or removes it', () => {
  const none = (build, side = 'R') => { const t = tx(); build(t); return T.findWrite(t.entries, q({ side })); };
  // 부분 문자열 치환: 입력의 new_string 은 그 줄이지만, 실제 바뀐 줄은 '  <그 줄> // keep'
  assert.equal(none((t) => t.tool('Edit', { file_path: F, old_string: 'PLACEHOLDER', new_string: LINE, replace_all: true }, 'The file has been updated.',
    { tur: editTur('PLACEHOLDER', LINE, [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-  PLACEHOLDER // keep', `+  ${LINE} // keep`] }]) })), null);
  // MultiEdit 중간 상태: 첫 편집이 넣고 둘째가 지웠다 — 실제 변경은 a() → b()
  for (const side of ['R', 'L']) {
    assert.equal(none((t) => t.tool('MultiEdit', { file_path: F, edits: [{ old_string: 'a();', new_string: LINE }, { old_string: LINE, new_string: 'b();' }] },
      'Applied 2 edits.', { tur: editTur('a();', 'b();') }), side), null, side);
  }
  // Write update 가 그 줄을 그대로 두었다(문맥 줄) — 다시 쓴 게 아니다
  const content = `${LINE}\nmore();\n`;
  assert.equal(none((t) => t.tool('Write', { file_path: F, content }, 'File updated.', { tur: writeTur('update', content, `${LINE}\n`) })), null);
  // toolUseResult 가 없거나, 객체가 아니거나, structuredPatch 가 없으면 후보가 아니다
  for (const tur of [null, 'Error: something', { originalFile: 'a();' }, { structuredPatch: 'x' }, { type: 'update', content }]) {
    assert.equal(none((t) => t.edit(F, 'a();', LINE, { tur })), null, JSON.stringify(tur));
  }
  assert.equal(none((t) => t.tool('Write', { file_path: F, content }, 'File created successfully.', { tur: { type: 'create', content: 'other();\n', structuredPatch: [] } })), null);   // create 는 결과의 content 로 본다
  // 실제로 그 줄을 더한 편집은 고른다
  const t = tx();
  const real = t.edit(F, 'a();', `a();\n${LINE}`);
  assert.equal(T.findWrite(t.entries, q()).index, real);
});

test('a line with quotes and backslashes in an Edit is found', () => {
  const line = 'say("a\\\\b")';   // 파일 속 줄: say("a\\b")
  const t = tx();
  const e = t.edit(F, 'old();', `x();\n${line}\n`);
  t.edit(F, 'q();', 'say("a\\b")');   // 역슬래시 하나짜리 다른 줄
  // JSONL 로 썼다 읽는다(JSON 이스케이프 왕복) — 깨진 줄은 건너뛴다
  const text = [JSON.stringify(t.entries[0]), '{"type":"assistant", broken', JSON.stringify(t.entries[1]), '', ...t.entries.slice(2).map((x) => JSON.stringify(x))].join('\n');
  const parsed = T.parseJsonl(text);
  assert.equal(parsed.length, t.entries.length);
  assert.deepEqual(parsed.map((x) => x._i), [0, 2, 4, 5]);
  const r = T.findWrite(parsed, q({ text: line }));
  assert.equal(r.index, e);
  assert.equal(r.toolUseId, t.idAt(e));
  assert.equal(T.findWrite(parsed, q({ text: 'say("a\\b")' })).index, 2);
});

test('a /tmp path matches its /private/tmp realpath', () => {
  // macOS 에서 /tmp 는 /private/tmp 링크다. 리눅스에서도 같은 길을 타게 링크 폴더를 하나 더 둔다
  const dir = fs.mkdtempSync('/tmp/viewed-tx-');
  try {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'a.ts'), '');
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    const real = fs.realpathSync(path.join(dir, 'real', 'a.ts'));
    const resolve = (p) => { try { return fs.realpathSync(p); } catch { return path.normalize(p); } };
    for (const written of [path.join(dir, 'real', 'a.ts'), path.join(dir, 'link', 'a.ts')]) {
      const t = tx();
      const e = t.edit(written, 'x();', LINE);
      const r = T.findWrite(t.entries, q({ files: [real] }), resolve);
      assert.equal(r && r.index, e, written);
    }
    const t = tx();
    t.edit(path.join(dir, 'link', 'a.ts'), 'x();', LINE);
    assert.equal(T.findWrite(t.entries, q({ files: [real] })), null);   // 기본(정규화만)은 링크를 안 따라간다
    // 발췌도 같은 resolve 로 링크 경로를 레포 안으로 본다 — 홈 아래 링크 레포에서 결과 글의 링크 경로가 섞임으로 잡히지 않게
    const home = dir;
    const repo = fs.realpathSync(path.join(dir, 'real'));
    const linked = path.join(dir, 'link', 'a.ts');
    const x = tx();
    const f = x.human('go');
    x.tool('Read', { file_path: linked }, 'READ-VIA-LINK');
    x.say(`${linked} 을 고친다`);
    const e = x.tool('Edit', { file_path: linked, old_string: 'x();', new_string: LINE }, `The file ${linked} has been updated.`);
    const ctx = { roots: [repo], home, allowDirs: [] };
    const ex = T.buildExcerpt(x.entries, f, e, { ...ctx, resolvePath: resolve });
    assert.ok(ex.text && ex.text.includes('READ-VIA-LINK') && ex.text.includes(LINE), JSON.stringify(ex));
    assert.deepEqual(T.buildExcerpt(x.entries, f, e, ctx), { mixed: true });   // 링크를 못 풀면 밖 경로다
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isMeta, tool_result and command wrapper entries are not human prompts', () => {
  const t = tx();
  const human = t.human('왜 이렇게 했어?');
  const arr = t.human('배열 모양 메시지', { array: true });
  const meta = t.human('Caveat: The messages below were generated by the user', { meta: true });
  const cmd = t.human('<command-name>/clear</command-name>\n<command-message>clear</command-message>');
  const out = t.human('<local-command-stdout>ok</local-command-stdout>');
  const rem = t.human('  <system-reminder>x</system-reminder>');
  const brief = t.human('You are implementing Task 2', { sidechain: true });   // 서브에이전트 브리프는 사람이 친 게 아니다
  const read = t.tool('Read', { file_path: F }, 'contents');
  const say = t.say('hello');
  const yes = (i) => T.isHumanPrompt(t.entries[i]);
  assert.equal(yes(human), true);
  assert.equal(yes(arr), true);
  for (const i of [meta, cmd, out, rem, brief, read, read + 1, say]) assert.equal(yes(i), false, JSON.stringify(t.entries[i]));
  for (const e of [null, {}, { type: 'summary', summary: 'x' }, { type: 'user', message: { content: '   ' } }, { type: 'user' }]) assert.equal(T.isHumanPrompt(e), false);
});

test('the excerpt keeps prose and in-repo file tools, drops Bash and foreign tools', () => {
  const t = tx();
  t.human('EARLIER-PROMPT');
  const from = t.human('리뷰 지적 고쳐줘');
  t.think('THINK-regression test first');
  t.say('SAY-먼저 재현 테스트를 쓴다.');
  t.tool('Read', { file_path: F }, 'READ-IN-REPO');
  t.tool('Grep', { pattern: 'compute', path: R }, 'GREP-IN-REPO');
  t.tool('Glob', { pattern: '**/*.ts' }, 'GLOB-IN-REPO-CWD', { cwd: R });                 // path 없음 → 그 기록의 cwd
  t.tool('Glob', { pattern: '**/*.md' }, 'GLOB-OUTSIDE-CWD', { cwd: '/home/u/work' });
  t.tool('Bash', { command: 'BASH-CMD' }, 'BASH-OUT');
  t.tool('WebFetch', { url: 'https://example.com' }, 'WEB-OUT');
  t.tool('Read', { file_path: '/home/u/elsewhere/notes.md' }, 'FOREIGN-READ');           // 밖 경로는 입력째로 빠진다 — 섞임 판정도 안 탄다
  t.tool('mcp__x__y', { file_path: F, q: 'MCP-IN' }, 'MCP-OUT');                       // 레포 안 경로를 받아도 파일 도구가 아니면 뺀다
  t.tool('Agent', { description: 'd', prompt: 'AGENT-PROMPT' }, 'AGENT-OUT');
  t.tool('TodoWrite', { todos: [{ content: 'TODO-ITEM' }] }, 'TODO-OUT');
  t.human('<system-reminder>REMINDER</system-reminder>');
  const e = t.edit(F, 'old();', 'NEW-LINE-WRITTEN();');
  t.say('LATER-SAY');
  const r = T.buildExcerpt(t.entries, from, e, CTX);
  assert.equal(r.mixed, undefined);
  const has = (s) => r.text.includes(s);
  for (const s of ['리뷰 지적 고쳐줘', 'THINK-regression', 'SAY-먼저 재현', 'READ-IN-REPO', 'GREP-IN-REPO', 'GLOB-IN-REPO-CWD', 'NEW-LINE-WRITTEN();', 'The file has been updated.']) assert.ok(has(s), s);
  for (const s of ['EARLIER-PROMPT', 'LATER-SAY', 'GLOB-OUTSIDE-CWD', 'BASH-CMD', 'BASH-OUT', 'WEB-OUT', 'example.com', 'FOREIGN-READ', 'elsewhere', 'MCP-IN', 'MCP-OUT', 'AGENT-PROMPT', 'AGENT-OUT', 'TODO-ITEM', 'REMINDER']) assert.ok(!has(s), s);
  assert.ok(r.text.indexOf('리뷰 지적') < r.text.indexOf('SAY-먼저') && r.text.indexOf('SAY-먼저') < r.text.indexOf('NEW-LINE-WRITTEN'));   // 오래된→최근
  // 머리 줄은 주면 맨 위에
  assert.ok(T.buildExcerpt(t.entries, from, e, { ...CTX, title: '세션 sess-1, 오래된→최근' }).text.startsWith('세션 sess-1, 오래된→최근\n'));
});

// 말 한 줄을 사이에 둔 최소 발췌
const runSay = (text, ctx = CTX, file = F) => {
  const t = tx();
  const f = t.human('go');
  t.say(text);
  const e = t.edit(file, 'a();', 'bbbbbbbbbb();');
  return T.buildExcerpt(t.entries, f, e, ctx);
};

test('a foreign absolute path in kept text drops the whole excerpt', () => {
  const ctx = { roots: [R, '/home/u/my repo'], home: '/home/u', allowDirs: ['/home/u/.claude', '/home/u/Library/Application Support/claude-profiles/p1', '/tmp'] };
  // 경로 시작은 앞 글자와 상관없이 찾는다(a/home/u/b 도 홈 경로로 본다)
  for (const bad of ['읽음: /home/u/other/.env', 'see ~/other/.env', 'see $HOME/other/x', 'see ${HOME}/other/x', 'see "$HOME"/other/x', 'see "${HOME}"/other/x',
    'see /home/u/viewed-company/src/a.ts', 'file:///home/u/other/x', '"/home/u/other"', 'a/home/u/b is relative']) {
    assert.deepEqual(runSay(bad, ctx), { mixed: true }, bad);
  }
  for (const ok of ['규칙 ~/.claude/rules/x.md 에 따라', '/tmp/x 에 썼다', 'see /home/u/viewed/src/a.ts:12', '`/home/u/viewed`', 'in "/home/u/my repo/b.ts"', 'in /home/u/my repo/b.ts', 'profile "/home/u/Library/Application Support/claude-profiles/p1/settings.json"', 'profile /home/u/Library/Application Support/claude-profiles/p1/settings.json', 'home is /home/u and ~/', '/home/user2/x is not under home', 'the repo is /home/u/viewed.', 'cd /home/u/viewed && ls', '/home/u/viewed/src/../lib/b.ts 를 본다', '/home/u//viewed/src/a.ts']) {
    const r = runSay(ok, ctx);
    assert.equal(r.mixed, undefined, ok);
    assert.ok(r.text.includes(ok), ok);
  }
  // 레포 안 도구의 결과 속 밖 경로도 섞임이다
  const t = tx();
  const f = t.human('go');
  t.tool('Read', { file_path: `${R}/cfg.ts` }, 'const p = "/home/u/other/.env";');
  const e = t.edit(F, 'a();', 'bbbbbbbbbb();');
  assert.deepEqual(T.buildExcerpt(t.entries, f, e, ctx), { mixed: true });
});

test('foreign paths are judged after normalizing and resolving, with no raw prefix shortcut', () => {
  // 루트·허용 폴더 이름으로 시작해도, '..'·이름 글자가 이어지면 다른 경로다. 공백 든 형제 폴더는 따옴표로 감쌌을 때만 읽는다(spec §12)
  for (const bad of ['"/home/u/viewed copy/.env"', "'~/viewed copy/.env'", '/home/u/viewed/../other/.env', '~/viewed/../other/.env',
    '~/.claude/../other/.env', '/home/u/viewed+other/.env', '$HOME/viewed/../other/.env']) {
    assert.deepEqual(runSay(`see ${bad} now`), { mixed: true }, bad);
  }
  // resolvePath 가 레포 안처럼 보이는 경로를 밖으로 풀면 밖이다
  const prefix = '/home/u/viewed/link/';
  const resolvePath = (p) => (p.startsWith(prefix) ? `/home/u/other/${p.slice(prefix.length)}` : path.posix.normalize(p));
  assert.deepEqual(runSay('see /home/u/viewed/link/x.ts', { ...CTX, resolvePath }), { mixed: true });
  assert.equal(runSay('see /home/u/viewed/link/x.ts').mixed, undefined);   // 링크를 모르면 레포 안
  // resolvePath 가 실패해도 '..' 을 푼 경로로 본다
  const failing = (p) => { if (p.includes('other') || p.includes('..')) throw new Error('ENOENT'); return path.posix.normalize(p); };
  assert.deepEqual(runSay('see /home/u/viewed/../other/.env', { ...CTX, resolvePath: failing }), { mixed: true });
});

test('a path token is never joined with the next word', () => {
  // 다음 낱말의 '..' 이 밖 경로를 지워 레포 안처럼 보이게 하면 안 된다
  for (const bad of ['diff /home/u/other/.env ./../../../x', 'diff /home/u/other/.env a/../../../../tmp/x', 'cp /home/u/other/.env src/../../../../../home/u/viewed/.env']) {
    assert.deepEqual(runSay(bad), { mixed: true }, bad);
  }
  const mac = ['', 'Users', 'u'].join('/');   // 공개 레포 스캔에 안 걸리게 실행 중에 만든다
  const ctx = { roots: [`${mac}/viewed`], home: mac, allowDirs: [] };
  assert.deepEqual(runSay(`${mac}/other /../viewed/a.js`, ctx, `${mac}/viewed/src/a.ts`), { mixed: true });
});

test('an unclosed quote does not join the path with the next word', () => {
  // 닫는 따옴표가 같은 줄에 없으면 따옴표 범위가 아니다 — 공백 너머의 '..' 이 밖 경로를 지우지 못한다
  for (const bad of ['diff "/home/u/other/.env ./../../../x', 'cp "/home/u/other/.env src/../../../../../home/u/viewed/.env', '"/home/u/other /../viewed/a.js',
    "x='/home/u/other /../viewed/a.js", 'x="a"/home/u/other /../viewed/a.js', 'see "/home/u/other/.env\n/../viewed/a.js"',
    `"/home/u/other ${'x'.repeat(4100)}/../../viewed/a"`]) {   // 닫는 따옴표가 4096자 너머면 따옴표 범위가 아니다 — 그 안의 '..' 이 밖 경로를 못 지운다
    assert.deepEqual(runSay(bad), { mixed: true }, bad);
  }
  // 닫는 따옴표가 같은 줄에 있으면 그 안이 한 경로다(공백 든 루트) · 따옴표 범위가 아니어도 레포 안 경로는 남는다
  const ctx = { roots: [R, '/home/u/my repo'], home: '/home/u', allowDirs: [] };
  for (const ok of ['in "/home/u/my repo/b.ts" now', 'x="a"/home/u/viewed/src/a.ts', '"/home/u/viewed/a.ts /home/u/viewed/b.ts"', "x='/home/u/viewed/a.ts"]) {
    const r = runSay(ok, ctx);
    assert.equal(r.mixed, undefined, ok);
    assert.ok(r.text.includes(ok), ok);
  }
});

test('a quoted token is also judged by its unquoted extent', () => {
  // 닫힌 따옴표 안이라도 공백 너머의 '..' 이 밖 경로를 레포 안으로 되돌리면 안 된다 — 따옴표 범위와 공백까지의 범위를 둘 다 본다
  const ctx = { roots: [R, '/home/u/my repo'], home: '/home/u', allowDirs: ['/home/u/.claude'] };
  for (const bad of ['"/home/u/other /../viewed/a.js"', "'/home/u/other /../viewed/a.js'", '`/home/u/other /../viewed/a.js`', '"/home/u/viewed client copy/.env"',
    'see "/home/u/other /../viewed/a.js" now', '"~/other /../viewed/a.js"', '"/home/u/my repo /../other/.env"']) {
    assert.deepEqual(runSay(bad, ctx), { mixed: true }, bad);
  }
  for (const ok of ['"/home/u/viewed/src/a.ts"', '"/home/u/my repo/src/a.ts"', '"~/.claude/rules/x.md"', "'/home/u/viewed/src/a.ts'", '`/home/u/my repo/src/a.ts`',
    'see "/home/u/my repo/src/a.ts", then', '"~/my repo/src/a.ts"',
    '"/home/u/viewed."', '"/home/u/my repo."',   // 따옴표 없는 범위도 끝의 문장 부호를 뗀다
    '"/home/u/viewed\n/../x"']) {               // 닫는 따옴표가 다음 줄이면 따옴표 범위가 아니다 — 줄 너머의 '..' 로 레포 밖처럼 읽지 않는다
    const r = runSay(ok, ctx);
    assert.equal(r.mixed, undefined, ok);
    assert.ok(r.text.includes(ok), ok);
  }
});

test('characters after a root inside one token make it a different path', () => {
  for (const bad of ['/home/u/viewed(1)/.env', '/home/u/viewed,old/.env', '/home/u/viewed[old]/.env', '/home/u/viewed;x/.env', "/home/u/viewed'x/.env",
    '"/home/u/viewed client copy/.env"', '"/home/u/viewed(company)/.env"']) {
    assert.deepEqual(runSay(`see ${bad} now`), { mixed: true }, bad);
  }
  // 따옴표 토막은 같은 줄, 4096자까지 — 그 너머의 밖 경로를 삼키지 않는다
  assert.deepEqual(runSay("see '/home/u/viewed/a.ts\nthen /home/u/other/.env' now"), { mixed: true });
  assert.deepEqual(runSay(`see "/home/u/viewed/${'x'.repeat(5000)} /home/u/other/.env now`), { mixed: true });
  // 끝의 문장 부호·닫는 괄호는 경로가 아니다
  for (const ok of ['in /home/u/viewed, then', '(see /home/u/viewed/src/a.ts)', '`~/.claude/rules/x.md`', '작업본은 /home/u/viewed/src 이다']) {
    const r = runSay(ok);
    assert.equal(r.mixed, undefined, ok);
    assert.ok(r.text.includes(ok), ok);
  }
});

test('the foreign-path check runs in linear time', () => {
  const cases = {
    '40000 slashes': '/'.repeat(40000),
    '4000 slash words': Array.from({ length: 4000 }, (_, k) => `/w${k}/x`).join(' '),
    '20000 in-repo paths': Array.from({ length: 20000 }, (_, k) => `/home/u/viewed/a${k}.ts`).join(' '),
    'one long home token': '/home/u'.repeat(6000),
    'one long in-repo token': '/home/u/viewed'.repeat(3000),
    'one long token with many starts': '/home/u/viewed/a'.repeat(3000),
    'many starts before a long tail': `${'/home/u/viewed/a'.repeat(3000)}${'x'.repeat(200000)}`,   // 시작마다 끝까지 다시 훑거나 4096 에서 안 자르면 제곱
    '4000 quoted paths without a closing quote': Array.from({ length: 4000 }, () => '"~/viewed/a').join(' '),
    'a quoted path with no closing quote': `"~/${'x'.repeat(40000)}`,
    'a long run of trailing punctuation inside a token': `/home/u/viewed/${'.,'.repeat(20000)}x`,
    'many secrets with unclosed quotes': `password="${'a'.repeat(50)}\n`.repeat(2000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = performance.now();
    runSay(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `${name}: ${ms.toFixed(1)}ms`);
  }
  // 가리기도 선형이고, 2000개 값이 하나도 안 남는다(발췌는 블록을 1500자에서 자르니 가리기 함수에 직접 건다)
  const t0 = performance.now();
  const masked = T.scrubSecrets(cases['many secrets with unclosed quotes']);
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `scrub 2000 unclosed secrets: ${ms.toFixed(1)}ms`);
  assert.ok(!masked.includes('a'.repeat(50)), masked.slice(0, 200));
  assert.equal((masked.match(/\[가림\]/g) || []).length, 2000);
});

test('every path start is judged, even inside an earlier token', () => {
  for (const bad of ['PATH=/home/u/viewed/bin:/home/u/other/bin', '/home/u/viewed/a.ts,/home/u/other/.env', '~/viewed/x:~/other/y', '"/home/u/viewed/a /home/u/other/b"']) {
    assert.deepEqual(runSay(`see ${bad} now`), { mixed: true }, bad);
  }
  for (const ok of ['PATH=/home/u/viewed/bin:/home/u/viewed/node_modules/.bin', '/home/u/viewed/a.ts,~/viewed/b.ts']) {
    assert.equal(runSay(ok).mixed, undefined, ok);
  }
  // 토막은 앞 4096자로 본다 — 밖 경로로 시작한 긴 토막을 뒤의 '..' 이 레포 안으로 되돌리지 못한다
  assert.deepEqual(runSay(`/home/u/other/${'x/'.repeat(2100)}${'../'.repeat(2101)}viewed/a`), { mixed: true });
  // 따옴표 토막은 줄을 넘지 않는다 — 다음 줄의 '..' 이 밖 경로를 지우지 못한다
  assert.deepEqual(runSay("see '/home/u/other\n/../viewed/a' now"), { mixed: true });
});

test('known roots and allowDirs with spaces are read whole', () => {
  const ctx = { roots: [R, '/home/u/my repo'], home: '/home/u', allowDirs: ['/home/u/Library/Application Support/x/home'] };
  for (const ok of ['/home/u/Library/Application Support/x/home/projects/a.jsonl', '/home/u/my repo/src/a.ts', '/home/u/my repo and more',
    'see ~/my repo/src/a.ts, then', '(~/Library/Application Support/x/home/settings.json)', 'the repo /home/u/my repo.']) {
    const r = runSay(ok, ctx);
    assert.equal(r.mixed, undefined, ok);
    assert.ok(r.text.includes(ok), ok);
  }
  // 경계: 루트 뒤가 '/'·공백·끝 문장 부호·글 끝일 때만 통째로 읽는다(따옴표가 바로 붙으면 아니다)
  for (const bad of ['/home/u/my repo2/x', '/home/u/Library/Application Supportx/y', '/home/u/my repo/../other/.env', '~/my repository/x', 'cfg=/home/u/my repo" x']) {
    assert.deepEqual(runSay(bad, ctx), { mixed: true }, bad);
  }
});

test('the resolver gets the text as written, and a home with a space is read whole', () => {
  // 대소문자를 가리는 파일 시스템(리눅스 CI)에서 링크를 풀려면 접은 글자가 아니라 원래 글자를 넘겨야 한다
  const resolvePath = (p) => (p === '/home/u/Link/a.ts' ? '/home/u/viewed/a.ts' : path.posix.normalize(p));
  assert.equal(runSay('see /home/u/Link/a.ts', { ...CTX, resolvePath }).mixed, undefined);
  // 홈 경로에 공백이 있어도 홈까지는 한 토막이다
  const ctx = { roots: ['/home/u x/viewed'], home: '/home/u x', allowDirs: [] };
  assert.deepEqual(runSay('see /home/u x/other/.env', ctx, '/home/u x/viewed/a.ts'), { mixed: true });
  assert.equal(runSay('see /home/u x/viewed/b.ts', ctx, '/home/u x/viewed/a.ts').mixed, undefined);
});

test('the resolver is asked once per distinct path within one excerpt', () => {
  // 같은 경로가 1000번 나와도(글 속 언급 + 도구 대상) realpath 는 한 번
  const count = (fn) => { const seen = new Map(); return { seen, resolvePath: (p) => { seen.set(p, (seen.get(p) || 0) + 1); return fn(p); } }; };
  const same = count((p) => path.posix.normalize(p));
  const r = runSay(Array.from({ length: 1000 }, () => F).join(' '), { ...CTX, resolvePath: same.resolvePath });
  assert.equal(r.mixed, undefined);
  assert.deepEqual([...same.seen.entries()], [[F, 1]]);
  // 못 푸는 경로(ENOENT)도 한 번만 묻는다
  const failing = count(() => { throw new Error('ENOENT'); });
  const r2 = runSay(Array.from({ length: 1000 }, () => `${R}/missing.ts`).join(' '), { ...CTX, resolvePath: failing.resolvePath });
  assert.equal(r2.mixed, undefined);
  assert.deepEqual([...failing.seen.entries()].sort(), [[F, 1], [`${R}/missing.ts`, 1]].sort());
  // 캐시는 호출마다 새로 — 다른 호출에서는 다시 묻는다
  runSay(F, { ...CTX, resolvePath: same.resolvePath });
  assert.equal(same.seen.get(F), 2);
});

test('a foreign path in any kept block kind drops the excerpt', () => {
  const P = '/home/u/other/.env';
  const cases = {
    'human prompt': (t) => t.human(`see ${P}`),
    'subagent brief': (t) => t.human(`brief ${P}`, { sidechain: true }),
    thinking: (t) => t.think(`maybe ${P}`),
    'assistant text': (t) => t.say(`read ${P}`),
    'file-tool input': (t) => t.tool('Edit', { file_path: `${R}/cfg.ts`, old_string: 'a();', new_string: `const p = "${P}";` }, 'The file has been updated.'),
    'file-tool result': (t) => t.tool('Read', { file_path: `${R}/cfg.ts` }, `const p = "${P}";`),
  };
  for (const [kind, add] of Object.entries(cases)) {
    for (const [p, want] of [[P, true], [`${R}/x.ts`, false]]) {   // 같은 블록에 레포 안 경로면 남는다 — 그 블록이 발췌에 든다는 대조군
      const t = tx();
      const f = t.human('go');
      const i = add(t);
      const e = t.edit(F, 'a();', 'bbbbbbbbbb();');
      const entries = JSON.parse(JSON.stringify(t.entries).split(P).join(p));
      const r = T.buildExcerpt(entries, f, e, CTX);
      assert.equal(r.mixed === true, want, `${kind} ${p}`);
      if (!want) assert.ok(r.text.includes(`${R}/x.ts`), `${kind} kept ${i}`);
    }
  }
});

test('home and roots are compared case- and NFC-insensitively', () => {
  assert.deepEqual(runSay('see /HOME/U/other/.env'), { mixed: true });
  assert.equal(runSay('see /HOME/U/VIEWED/src/a.ts').mixed, undefined);
  const H = '/home/가';
  const ctx = { roots: [`${H}/viewed`], home: H, allowDirs: [] };
  const file = `${H}/viewed/a.ts`;
  assert.notEqual(`${H}/other/.env`.normalize('NFD'), `${H}/other/.env`);
  assert.deepEqual(runSay(`see ${`${H}/other/.env`.normalize('NFD')}`, ctx, file), { mixed: true });
  assert.equal(runSay(`see ${`${H}/viewed/b.ts`.normalize('NFD')}`, ctx, file).mixed, undefined);
  // 반대로 홈·루트가 NFD(realpath 가 그렇게 돌려줄 수 있다)이고 글이 NFC 여도 같다
  const d = { roots: [`${H}/viewed`.normalize('NFD')], home: H.normalize('NFD'), allowDirs: [] };
  assert.deepEqual(runSay(`see ${H}/other/.env`, d, `${H}/viewed/a.ts`.normalize('NFD')), { mixed: true });
});

test('the title goes through the same mixed check and masking', () => {
  const t = tx();
  const f = t.human('go');
  const e = t.edit(F, 'a();', 'bbbbbbbbbb();');
  assert.deepEqual(T.buildExcerpt(t.entries, f, e, { ...CTX, title: '/home/u/other/.env password=example-value' }), { mixed: true });
  const r = T.buildExcerpt(t.entries, f, e, { ...CTX, title: '세션 x password=example-value' });
  assert.ok(!r.text.includes('example-value') && r.text.startsWith('세션 x password=[가림]\n'), r.text);
});

test('secrets are masked', () => {
  // 공개 레포 스캔에 안 걸리게 토큰은 실행 중에 만든다
  const ghp = 'ghp_' + 'A1b2'.repeat(9);
  const pat = 'github_pat_' + 'x9'.repeat(15);
  const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const sk = 'sk-ant-api03-' + 'Qz_-'.repeat(8);
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowKEYBODY\n-----END RSA PRIVATE KEY-----';
  const kv = ['DB_PASSWORD=hunter22', 'apiKey: "abcd1234efgh"', 'GITHUB_TOKEN=tok_value_1', 'client_secret = s3cr3tvalue', '"api_key":"kkkkkkkk"'];
  const s = T.scrubSecrets(`a ${ghp} b ${pat} c ${aws} d ${sk}\n${key}\n${kv.join('\n')}\nif (token === undefined) return;`);
  for (const secret of [ghp, pat, aws, sk, 'MIIEowKEYBODY', 'hunter22', 'abcd1234efgh', 'tok_value_1', 's3cr3tvalue', 'kkkkkkkk']) assert.ok(!s.includes(secret), secret);
  assert.ok(s.includes('DB_PASSWORD=[가림]'), s);
  assert.ok(s.includes('if (token === undefined) return;'), s);   // 비교식은 값이 아니다
  // 따옴표 값은 닫는 따옴표까지 가린다(없으면 줄 끝까지)
  const quoted = T.scrubSecrets(`password="alpha beta gamma"\nsecret='one two three' tail\ntoken="no close here\nnext line`);
  for (const word of ['alpha', 'beta', 'gamma', 'one', 'two', 'three', 'no close', 'here']) assert.ok(!quoted.includes(word), `${word}: ${quoted}`);
  assert.ok(quoted.includes('password="[가림]"') && quoted.includes(' tail') && quoted.includes('next line'), quoted);
  // 닫는 따옴표가 다음 줄에 있어도 거기까지(4000자 안), 그보다 멀면 줄 끝까지
  const multi = T.scrubSecrets('password=`first part\nsecond part` after');
  assert.ok(!multi.includes('first part') && !multi.includes('second part') && multi.includes('` after'), multi);
  const far = T.scrubSecrets(`password="aaa\n${'b'.repeat(5000)}"`);
  assert.ok(!far.includes('aaa') && far.includes('b'.repeat(4000)), far.slice(0, 40));   // 가리는 범위는 4000자까지
  // 발췌에도 적용된다
  const t = tx();
  const f = t.human(`토큰은 ${ghp} 이야`);
  const e = t.edit(F, 'a();', `const k = "${aws}";`);
  const r = T.buildExcerpt(t.entries, f, e, CTX);
  assert.ok(!r.text.includes(ghp) && !r.text.includes(aws) && r.text.includes('[가림]'));
});

test('a quoted secret value never swallows the next secret key, and an escaped quote does not end the mask', () => {
  // 다음 비밀의 여는 따옴표를 닫는 따옴표로 삼으면 그 사이 값이 그대로 남는다 — 줄을 넘는 닫기는 사이에 다른 키가 없을 때만
  const gone = (input, values, keep = []) => {
    const out = T.scrubSecrets(input);
    for (const v of values) assert.ok(!out.includes(v), `${JSON.stringify(input)} left ${v}: ${out}`);
    for (const k of keep) assert.ok(out.includes(k), `${JSON.stringify(input)} lost ${k}: ${out}`);
    return out;
  };
  gone('password="AAA1\npassword="BBB2\npassword="CCC3\npassword="DDD4', ['AAA1', 'BBB2', 'CCC3', 'DDD4']);
  gone('password="AAA1 password="BBB2 password="CCC3', ['AAA1', 'BBB2', 'CCC3']);   // 같은 줄에서도 다음 키의 따옴표를 닫는 것으로 삼지 않는다
  gone('password="abc1\ntoken="xyz2"', ['abc1', 'xyz2']);
  gone('password: "abc1\nsecret: "def2"', ['abc1', 'def2']);
  gone("api_key='k1\napiKey='k2' rest", ['k1', 'k2'], [' rest']);
  // 이스케이프된 따옴표는 닫는 따옴표가 아니다 — 그 뒤도 줄 끝까지 가린다
  gone('password="abc\\"def', ['abc', 'def']);
  gone("password='it\\'s secret", ['it', 's secret']);
  assert.equal(gone('password="zq\\\\" tail', ['zq'], [' tail']), 'password="[가림]" tail');   // 역슬래시 자체를 이스케이프한 뒤의 따옴표는 닫는 것이다
  // 줄을 넘는 닫기는 사이에 키가 없고 4000자 안일 때만 — 그때는 거기까지 통째로
  gone('token="line one\nline two" rest\nsecret=plain', ['line one', 'line two', 'plain'], ['" rest']);
  assert.equal(gone('password="alpha beta gamma" x', ['alpha', 'beta', 'gamma']), 'password="[가림]" x');
  gone('password=`first part\nsecond part` after', ['first part', 'second part'], ['` after']);
  // 줄 끝까지 가린 뒤에는 다음 줄부터 다시 본다 — 다음 줄의 평문 값도 가린다
  gone('password="open\nDB_PASSWORD=hunter22\ntoken="v9"', ['open', 'hunter22', 'v9'], ['DB_PASSWORD=[가림]', 'token="[가림]"']);
});

test('caps keep the human prompt and drop the oldest blocks', () => {
  const t = tx();
  const f = t.human('H'.repeat(5000));
  for (let k = 0; k < 40; k++) t.say(`S${k}| ` + 'x'.repeat(3000));
  const e = t.edit(F, 'a();', 'final_line_here();');
  const r = T.buildExcerpt(t.entries, f, e, CTX);
  assert.ok(r.text.length <= T.EXCERPT.total, String(r.text.length));
  assert.ok(r.text.includes('H'.repeat(1900)) && !r.text.includes('H'.repeat(T.EXCERPT.human)));   // 사람 메시지는 2000자까지 남는다
  assert.ok(r.text.includes('final_line_here();'));
  assert.ok(r.text.includes('S39|') && !r.text.includes('S0|') && !r.text.includes('S1|'));
  assert.ok(r.text.indexOf('HHHH') < r.text.indexOf('S39|'));
  assert.ok(!/x{1500}/.test(r.text));   // 블록마다 1500자
  assert.match(r.text, /생략/);         // 버린 블록이 있다는 표시
  assert.equal(T.EXCERPT.block, 1500);
  assert.deepEqual(T.EXCERPT, { block: 1500, total: 30000, human: 2000, brief: 3000, lookback: 300, minChars: 8 });
});

test('a subagent brief is kept up to 3000 chars and the parent prompt opens the excerpt', () => {
  const t = tx();
  const parent = t.human('부모 세션의 사람 질문');
  const brief = t.human('B'.repeat(5000), { sidechain: true });
  t.say('ok', { sidechain: true });
  const e = t.tool('Edit', { file_path: F, old_string: 'a();', new_string: 'abcdefghij();' }, 'The file has been updated.', { sidechain: true });
  assert.equal(T.isHumanPrompt(t.entries[brief]), false);
  const r = T.buildExcerpt(t.entries, parent, e, CTX);
  assert.ok(r.text.startsWith('[사람') && r.text.includes('부모 세션의 사람 질문'));
  assert.ok(r.text.includes('B'.repeat(2900)) && !r.text.includes('B'.repeat(T.EXCERPT.brief)));
  assert.ok(r.text.includes('abcdefghij();'));
});

test('findSpawn links a subagent to the Agent call that started it', () => {
  assert.equal(T.subagentId('/home/u/.claude/projects/-home-u-work/sess-1/subagents/agent-a6abee1b23b9afe1a.jsonl'), 'a6abee1b23b9afe1a');
  assert.equal(T.subagentId('/home/u/.claude/projects/-home-u-work/sess-1.jsonl'), null);
  assert.equal(T.subagentId('/x/agent-abc.jsonl'), null);
  assert.equal(T.subagentId('/x/p/subagents/agent-abc.meta.json'), null);
  const t = tx();
  t.human('do it');
  t.tool('Agent', { description: 'one', prompt: 'p1' }, 'done\nagentId: aaa111 (for resuming)');
  const spawn = t.tool('Agent', { description: 'two', prompt: 'p2' }, [{ type: 'text', text: 'ok' }, { type: 'text', text: 'agentId: bbb222' }]);
  const viaTur = t.tool('Agent', { description: 'three', prompt: 'p3' }, 'Async agent launched.', { tur: { agentId: 'ccc333', status: 'async_launched' } });
  t.tool('Read', { file_path: F }, 'agentId: ddd444');
  t.tool('Agent', { description: 'again', prompt: 'p4' }, 'agentId: bbb222');   // 같은 id 를 다시 언급해도 띄운 건 처음 것
  assert.equal(T.findSpawn(t.entries, 'bbb222'), spawn);
  assert.equal(T.findSpawn(t.entries, 'ccc333'), viaTur);
  assert.equal(T.findSpawn(t.entries, 'aaa11'), null);   // 다른 id 의 앞부분
  assert.equal(T.findSpawn(t.entries, 'ddd444'), null);  // Agent 호출이 아니다
  assert.equal(T.findSpawn(t.entries, 'zzz999'), null);
  assert.equal(T.findSpawn(t.entries, 'a.*'), null);
});

// F8 — 실저장소에서 나온 거짓 '섞임'
const excerptOf = (text, ctx = CTX) => { const t = tx(); const h = t.human(text); return T.buildExcerpt(t.entries, h, h, ctx); };

test('bare home mentions and prose separated by a middle dot are not foreign paths', () => {
  for (const s of ['write ~/ then stop', 'home is /home/u', 'home is /home/u/.', '`~/`·`$HOME/`·`${HOME}/`', '~/·$HOME/·${HOME}/',
    '「~/」、「$HOME/」。（${HOME}/）《~/》“~/”‘$HOME/’『~/』，~/・$HOME/']) {
    const r = excerptOf(s);
    assert.ok(typeof r.text === 'string', s);
  }
});

test('a token that is an ancestor of a root is not foreign, a sibling still is', () => {
  const ctx = { ...CTX, roots: ['/home/u/work/viewed'] };
  assert.ok(typeof excerptOf('see /home/u/work and ~/work/', ctx).text === 'string');
  assert.deepEqual(excerptOf('see /home/u/work/other', ctx), { mixed: true });
});

test('a foreign path next to a middle dot is still foreign', () => {
  assert.deepEqual(excerptOf('`~/viewed/a.ts`·`~/other/.env`'), { mixed: true });
  assert.deepEqual(excerptOf('~/·/home/u/other/.env'), { mixed: true });
  assert.deepEqual(excerptOf('「~/viewed/a.ts」、「~/other/.env」'), { mixed: true });
});
