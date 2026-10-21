const path = require('node:path');

// Claude Code 세션 기록(jsonl, 내부 형식 — 2.1.x 에서 본 모양)을 판정하는 순수 함수. 파일은 읽지 않는다(훑기는 sessions.cjs).
// 원칙(spec §6): 틀린 세션을 근거로 드는 것보다 못 찾는 게 낫다. 모양이 낯설거나 애매하면 전부 '없음' 쪽으로 떨어뜨린다.

const EXCERPT = Object.freeze({ block: 1500, total: 30000, human: 2000, brief: 3000, lookback: 300, minChars: 8 });

const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob']);
// Claude Code 가 user 기록으로 끼워 넣는 꼬리표 — 사람이 친 글이 아니다
const INJECTED = ['<command-name>', '<command-message>', '<command-args>', '<local-command-', '<system-reminder>',
  '<bash-input>', '<bash-stdout>', '<bash-stderr>', '<task-notification>', '<user-prompt-submit-hook>'];
// 경로 이름에 이어지는 글자. 이게 뒤따르면 같은 이름이 아니다(/viewed 뒤의 -company)
const CONT = /[\p{L}\p{N}._-]/u;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
const MASK = '[가림]';

// 줄마다 JSON.parse. 깨진 줄·객체가 아닌 줄은 건너뛴다. _i = 파일 안 줄 순번(0부터)
function parseJsonl(text) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    e._i = i;
    out.push(e);
  }
  return out;
}

const items = (e) => { const c = e && e.message && e.message.content; return Array.isArray(c) ? c : []; };
// message.content 또는 tool_result.content — 문자열이거나 [{type:'text',text}]
const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '';

// user 기록 중 '글'인 것(사람 메시지 또는 서브에이전트 브리프). tool_result·isMeta·자동 삽입 꼬리표는 null
function promptText(e) {
  if (!e || e.type !== 'user' || e.isMeta === true || !e.message) return null;
  const c = e.message.content;
  if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) return null;
  const t = textOf(c);
  if (!t.trim()) return null;
  const head = t.trimStart();
  return INJECTED.some((tag) => head.startsWith(tag)) ? null : t;
}

// spec §6 '사람이 친 메시지'. 서브에이전트 쪽(isSidechain) user 기록은 컨트롤러가 보낸 브리프라 사람 메시지가 아니다
function isHumanPrompt(e) {
  return promptText(e) !== null && e.isSidechain !== true;
}

const trimSlash = (r) => (r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r);
const absNorm = (p) => (typeof p === 'string' && path.isAbsolute(p) ? trimSlash(path.normalize(p)) : null);

// 경계 비교 — /home/u/viewed 는 /home/u/viewed-company 를 품지 않는다
function insideAny(p, roots) {
  const x = absNorm(p);
  if (x === null || !Array.isArray(roots)) return false;
  return roots.some((r) => {
    const b = absNorm(r);
    return b !== null && (x === b || x.startsWith(b === '/' ? '/' : b + '/'));
  });
}

// tool_use_id → 결과. 같은 기록에 결과가 하나일 때만 toolUseResult 를 붙인다(여럿이면 어느 것의 것인지 모른다)
function results(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!e || e.type !== 'user') continue;
    const rs = items(e).filter((x) => x && x.type === 'tool_result' && typeof x.tool_use_id === 'string');
    for (const x of rs) {
      const text = textOf(x.content);
      const err = x.is_error === true || text.trimStart().startsWith('<tool_use_error>');
      const prev = m.get(x.tool_use_id);
      m.set(x.tool_use_id, {
        err: err || (prev ? prev.err : false),
        at: Date.parse(e.timestamp),
        text: prev ? `${prev.text}\n${text}` : text,
        tur: rs.length === 1 ? e.toolUseResult : undefined,
      });
    }
  }
  return m;
}

// 편집 도구 입력 → [{ old, neu }]. 모양이 다르면 빈 배열(후보 아님). Write 는 이전 내용을 모르니 old 는 빈 글
function writes(name, input) {
  if (!input || typeof input !== 'object') return [];
  const pair = (o, n) => (typeof o === 'string' && typeof n === 'string' ? [{ old: o, neu: n }] : []);
  if (name === 'Edit') return pair(input.old_string, input.new_string);
  if (name === 'Write') return pair('', input.content);
  if (name === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.flatMap((x) => (x ? pair(x.old_string, x.new_string) : []));
  return [];
}

const hasLine = (s, want) => s.split('\n').some((l) => l.trim() === want);
const longEnough = (t) => t.replace(/\s/g, '').length >= EXCERPT.minChars;

// 그 줄을 "쓴" 편집 하나(spec §6 후보 조건). at = 편집이 끝난 시각(결과 기록) — 권한 대기 중 커밋이 끼어들어도 늦은 쪽으로 잰다
function findWrite(entries, q, resolvePath = path.normalize) {
  if (!Array.isArray(entries) || !q || typeof q.text !== 'string' || (q.side !== 'L' && q.side !== 'R')
    || !Array.isArray(q.files) || !Number.isFinite(q.until)) return null;
  const want = q.text.trim();
  if (!longEnough(want)) return null;
  const files = new Set(q.files.map(absNorm).filter((f) => f !== null));
  const res = results(entries);
  let best = null;
  entries.forEach((e, index) => {
    if (!e || e.type !== 'assistant') return;
    for (const x of items(e)) {
      if (!x || x.type !== 'tool_use' || !WRITE_TOOLS.has(x.name) || typeof x.id !== 'string') continue;
      const fp = x.input && x.input.file_path;
      if (typeof fp !== 'string' || !path.isAbsolute(fp)) continue;
      let real;
      try { real = absNorm(resolvePath(fp)); } catch { continue; }
      if (real === null || !files.has(real)) continue;
      const r = res.get(x.id);
      if (!r || r.err) continue;   // 결과가 없거나(중단) 실패한 편집
      const times = [Date.parse(e.timestamp), r.at].filter(Number.isFinite);
      if (!times.length) continue;
      const at = Math.max(...times);
      if (at > q.until) continue;
      const wrote = writes(x.name, x.input).some(({ old, neu }) => {
        const o = hasLine(old, want);
        const n = hasLine(neu, want);
        return q.side === 'R' ? n && !o : o && !n;
      });
      if (wrote && (!best || at >= best.at)) best = { index, at, toolUseId: x.id };
    }
  });
  return best;
}

// '<부모>/subagents/agent-<id>.jsonl' → id
function subagentId(file) {
  if (typeof file !== 'string') return null;
  const m = /\/[^/]+\/subagents\/agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(file);
  return m ? m[1] : null;
}

// 결과에 그 agentId 가 든 Agent 호출의 index. 같은 id 를 다시 언급한 호출이 있어도 띄운 것(처음)을 돌려준다
function findSpawn(parentEntries, agentId) {
  if (!Array.isArray(parentEntries) || typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return null;
  const mark = new RegExp(`agentId:\\s*${agentId}(?![A-Za-z0-9_-])`);
  const res = results(parentEntries);
  for (let i = 0; i < parentEntries.length; i++) {
    const e = parentEntries[i];
    if (!e || e.type !== 'assistant') continue;
    for (const x of items(e)) {
      if (!x || x.type !== 'tool_use' || x.name !== 'Agent') continue;
      const r = res.get(x.id);
      if (!r) continue;
      const tur = r.tur;
      if (mark.test(r.text) || (typeof tur === 'string' && mark.test(tur))
        || (tur && typeof tur === 'object' && tur.agentId === agentId)) return i;
    }
  }
  return null;
}

const SECRETS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,   // 머리부터 끝(없으면 글 끝)까지
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
];
// 이름=값 · 이름: 값 · "이름":"값". 비교(==)·화살표(=>)는 값이 아니다
const KV = /((?:password|passwd|secret|token|api[-_.]?key)[A-Za-z0-9_.-]*["']?\s*(?::|=(?![=>]))\s*["']?)([^\s"'`,;]+)/gi;

function scrubSecrets(s) {
  let out = String(s);
  for (const re of SECRETS) out = out.replace(re, MASK);
  return out.replace(KV, (_, k) => k + MASK);
}

// 남긴 글 속 홈 아래 절대 경로가 P(레포·워크트리)·허용 폴더 밖이면 true. 홈을 모르면 판정할 수 없으니 true
function foreignPath(text, ctx, resolve) {
  const home = absNorm(ctx.home);
  if (home === null || home === '/') return true;
  const allowed = [...(ctx.roots || []), ...(ctx.allowDirs || [])].map(absNorm).filter((a) => a !== null);
  // at 자리가 이름의 끝인가: 글 끝이거나 '/' 도 이름 글자도 아니다
  const stop = (s, at) => at >= s.length || (s[at] !== '/' && !CONT.test(s[at]));
  const ok = (s) => {   // s 는 홈으로 시작하는 나머지 글
    const n = home.length;
    if (stop(s, n) || (s[n] === '/' && stop(s, n + 1))) return true;   // 홈 자체('/home/u', '~/')
    if (allowed.some((a) => s.startsWith(a) && (s.length === a.length || s[a.length] === '/' || stop(s, a.length)))) return true;
    // 링크 경로(레포 폴더가 심볼릭 링크)는 findWrite 와 같은 resolve 로 풀어 본다. 경로는 공백·따옴표·괄호 앞까지, 끝의 :줄:칸 은 뗀다
    const token = /^[^\s"'`<>()[\]{},;|]+/.exec(s)[0].replace(/(?::\d+){1,2}$/, '').replace(/[.:]+$/, '');
    try { return insideAny(resolve(token), allowed); } catch { return false; }
  };
  const starts = (i) => i === 0 || !CONT.test(text[i - 1]);
  for (let i = text.indexOf(home); i !== -1; i = text.indexOf(home, i + 1)) {
    if (!starts(i)) continue;
    const s = text.slice(i);
    if (!stop(s, home.length) && s[home.length] !== '/') continue;   // /home/u2 는 홈이 아니다
    if (!ok(s)) return true;
  }
  for (const alias of ['~/', '$HOME/', '${HOME}/']) {
    for (let i = text.indexOf(alias); i !== -1; i = text.indexOf(alias, i + 1)) {
      if (!starts(i)) continue;
      if (!ok(home + text.slice(i + alias.length - 1))) return true;
    }
  }
  return false;
}

// 서로게이트 쌍을 가르지 않고 n 자 이하로 자른다
function cut(s, n) {
  if (s.length <= n) return s;
  let k = n - 1;
  const c = s.charCodeAt(k - 1);
  if (c >= 0xd800 && c <= 0xdbff) k -= 1;
  return s.slice(0, k) + '…';
}

function clock(ts) {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, '0');
  return ` · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 파일 도구의 대상. Grep·Glob 은 path 가 없으면 그 기록의 cwd. 상대 경로·모르는 대상은 null
function target(x, e, resolve) {
  const inp = x.input || {};
  let p = x.name === 'Grep' || x.name === 'Glob' ? (inp.path === undefined || inp.path === null || inp.path === '' ? e.cwd : inp.path) : inp.file_path;
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  try { p = resolve(p); } catch { return null; }
  return absNorm(p);
}

function renderInput(name, inp) {
  if (name === 'Edit') return `--- old_string\n${inp.old_string}\n+++ new_string\n${inp.new_string}`;
  if (name === 'MultiEdit') return (Array.isArray(inp.edits) ? inp.edits : []).map((x, k) => `--- old_string #${k + 1}\n${x && x.old_string}\n+++ new_string #${k + 1}\n${x && x.new_string}`).join('\n');
  if (name === 'Write') return `+++ content\n${inp.content}`;
  const rest = { ...inp };   // Read·Grep·Glob: 대상 파일은 머리에 있으니 나머지 인자만
  delete rest.file_path;
  return Object.keys(rest).length ? JSON.stringify(rest) : '';
}

// entries[from..to] 를 블록으로 거른다(spec §6 발췌). to 의 편집처럼 범위 안 도구의 결과는 범위 뒤에 있어도 같이 붙인다.
// ctx = { roots, home, allowDirs, resolvePath?, title? } — resolvePath 는 findWrite 와 같은 것을 넘긴다(/tmp ↔ /private/tmp)
function buildExcerpt(entries, from, to, ctx) {
  const c = ctx || {};
  const resolve = typeof c.resolvePath === 'function' ? c.resolvePath : path.normalize;
  const roots = Array.isArray(c.roots) ? c.roots : [];
  const list = Array.isArray(entries) ? entries : [];
  const res = results(list);
  const lo = Math.max(0, Math.trunc(Number(from)) || 0);
  const hi = Math.min(list.length - 1, Math.trunc(Number(to)));
  const blocks = [];   // { keep, cap, text } — keep: 합계를 넘어도 남기는 여는 글
  for (let i = lo; i <= hi; i++) {
    const e = list[i];
    if (!e) continue;
    const when = clock(e.timestamp);
    if (e.type === 'user') {
      const t = promptText(e);   // tool_result 는 그 도구 블록에 붙는다. isMeta·자동 삽입은 뺀다
      if (t === null) continue;
      if (e.isSidechain === true) blocks.push({ keep: true, cap: EXCERPT.brief, text: `[브리프${when}]\n${t}` });
      else blocks.push({ keep: true, cap: EXCERPT.human, text: `[사람${when}]\n${t}` });
      continue;
    }
    if (e.type !== 'assistant') continue;
    for (const x of items(e)) {
      if (!x) continue;
      if (x.type === 'text' && typeof x.text === 'string' && x.text.trim()) {
        blocks.push({ keep: false, cap: EXCERPT.block, text: `[Claude${when}]\n${x.text}` });
      } else if (x.type === 'thinking' && typeof x.thinking === 'string' && x.thinking.trim()) {
        blocks.push({ keep: false, cap: EXCERPT.block, text: `[Claude 생각${when}]\n${x.thinking}` });
      } else if (x.type === 'tool_use' && FILE_TOOLS.has(x.name)) {
        const p = target(x, e, resolve);
        if (p === null || !insideAny(p, roots)) continue;   // 밖이거나 모르는 대상 — 입력·결과째 뺀다
        const r = res.get(x.id);
        const body = renderInput(x.name, x.input || {});
        blocks.push({ keep: false, cap: EXCERPT.block, text: `[${x.name} ${p}${when}]${body ? `\n${body}` : ''}${r ? `\n→ ${r.text}` : ''}` });
      }
      // Bash·웹·MCP·Agent 등은 넣지 않는다
    }
  }
  // 섞인 구간: 남긴 글 전체(자르기 전)에서 P 밖의 홈 경로가 보이면 세션 근거 전체를 뺀다
  if (blocks.some((b) => foreignPath(b.text, c, resolve))) return { mixed: true };

  const parts = blocks.map((b) => ({ keep: b.keep, text: cut(scrubSecrets(b.text), b.cap) }));
  const title = typeof c.title === 'string' && c.title ? cut(c.title, 200) : null;
  const sep = 2;   // '\n\n'
  const size = (ps, extra) => ps.reduce((n, p) => n + p.text.length + sep, (title ? title.length + 1 : 0) + extra);
  const note = (n) => `…(오래된 블록 ${n}개 생략)`;
  const dropped = new Set();
  const alive = () => parts.filter((_, k) => !dropped.has(k));
  const over = () => size(alive(), dropped.size ? note(dropped.size).length + sep : 0) > EXCERPT.total;
  // 오래된 쪽부터 버린다 — 여는 글(사람 메시지·브리프)은 마지막까지 남긴다
  for (const keepPass of [false, true]) {
    for (let k = 0; k < parts.length && over(); k++) if (parts[k].keep === keepPass) dropped.add(k);
  }
  const out = [];
  let marked = false;
  parts.forEach((p, k) => {
    if (dropped.has(k)) { if (!marked) { out.push(note(dropped.size)); marked = true; } return; }
    out.push(p.text);
  });
  const text = out.join('\n\n');
  return { text: title ? `${title}\n${text}` : text };
}

module.exports = { EXCERPT, parseJsonl, isHumanPrompt, insideAny, findWrite, subagentId, findSpawn, buildExcerpt, scrubSecrets };
