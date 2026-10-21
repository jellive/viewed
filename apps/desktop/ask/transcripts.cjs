const path = require('node:path');

// Claude Code 세션 기록(jsonl, 내부 형식 — 2.1.x 에서 본 모양)을 판정하는 순수 함수. 파일은 읽지 않는다(훑기는 sessions.cjs).
// 원칙(spec §6): 틀린 세션을 근거로 드는 것보다 못 찾는 게 낫다. 모양이 낯설거나 애매하면 전부 '없음' 쪽으로 떨어뜨린다.

const EXCERPT = Object.freeze({ block: 1500, total: 30000, human: 2000, brief: 3000, lookback: 300, minChars: 8 });

const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob']);
// Claude Code 가 user 기록으로 끼워 넣는 꼬리표 — 사람이 친 글이 아니다
const INJECTED = ['<command-name>', '<command-message>', '<command-args>', '<local-command-', '<system-reminder>',
  '<bash-input>', '<bash-stdout>', '<bash-stderr>', '<task-notification>', '<user-prompt-submit-hook>'];
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

// 편집이 실제로 바꾼 줄 — 결과 기록의 toolUseResult.structuredPatch(hunk 의 lines 는 ' '·'+'·'-' 로 시작).
// 입력(old_string·new_string)은 보지 않는다: 부분 문자열 치환·replace_all·MultiEdit 중간 상태는 입력만으로 순변화를 모른다.
// Write 새 파일(type 'create')은 패치가 비어 있으니 content 전체가 더한 줄이다. 모양이 다르면 null — 후보가 아니다
function changed(name, tur) {
  if (!tur || typeof tur !== 'object' || Array.isArray(tur)) return null;
  const sp = tur.structuredPatch;
  if (name === 'Write' && tur.type === 'create' && (!Array.isArray(sp) || sp.length === 0)) {
    return typeof tur.content === 'string' ? { add: tur.content.split('\n'), del: [] } : null;
  }
  if (!Array.isArray(sp)) return null;
  const add = [];
  const del = [];
  for (const h of sp) {
    if (!h || !Array.isArray(h.lines)) return null;
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      if (l[0] === '+') add.push(l.slice(1));
      else if (l[0] === '-') del.push(l.slice(1));
    }
  }
  return { add, del };
}

const longEnough = (t) => t.replace(/\s/g, '').length >= EXCERPT.minChars;

// 그 줄을 "쓴" 편집 하나(spec §6 후보 조건). at = 결과 기록 시각(편집이 끝난 때) — 없거나 못 읽으면 후보가 아니다
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
      const at = r.at;
      if (!Number.isFinite(at) || at > q.until) continue;
      const ch = changed(x.name, r.tur);
      if (!ch) continue;
      const wrote = (q.side === 'R' ? ch.add : ch.del).some((l) => l.trim() === want);
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
// 이름=값 · 이름: 값 · "이름":"값". 비교(==)·화살표(=>)는 값이 아니다.
const KV_KEY = /(?:password|passwd|secret|token|api[-_.]?key)[A-Za-z0-9_.-]*["']?\s*(?::|=(?![=>]))\s*/gi;
const KV_KEY_INSIDE = new RegExp(KV_KEY.source, 'i');   // 따옴표 값 안에 다른 키가 있나
const KV_BARE = /[^\s"'`,;]+/y;
const KV_SPAN = 4000;

// 따옴표 값의 닫는 따옴표 자리(역슬래시 이스케이프는 건너뛴다). 4000자 안에 없으면 -1
function closeQuote(s, from, q) {
  const limit = Math.min(s.length, from + KV_SPAN + 1);
  for (let i = from; i < limit; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === q) return i;
  }
  return -1;
}

// 따옴표 값은 닫는 따옴표까지 — 단 그 사이에 다른 비밀 키가 없고 4000자 안일 때만(줄을 넘어도 된다). 아니면(다음 비밀의 여는 따옴표를
// 닫는 것으로 삼지 않게) 그 줄 끝까지 가리고 다음 줄부터 다시 본다. 같은 줄에서도 사이에 키가 있으면 줄 끝까지다. 이스케이프된 따옴표는 닫는 것이 아니다
function scrubKV(s) {
  let out = '';
  let pos = 0;
  KV_KEY.lastIndex = 0;
  for (let m = KV_KEY.exec(s); m; m = KV_KEY.exec(s)) {
    const vStart = m.index + m[0].length;
    const q = s[vStart];
    let vEnd;
    let rep;
    if (q === '"' || q === "'" || q === '`') {
      const close = closeQuote(s, vStart + 1, q);
      const body = close === -1 ? null : s.slice(vStart + 1, close);
      if (body !== null && !KV_KEY_INSIDE.test(body)) vEnd = close + 1;
      else { const nl = s.indexOf('\n', vStart + 1); vEnd = nl === -1 ? s.length : nl; }
      rep = q + MASK + q;
    } else {
      KV_BARE.lastIndex = vStart;
      const b = KV_BARE.exec(s);
      if (!b) continue;   // 값이 없다
      vEnd = vStart + b[0].length;
      rep = MASK;
    }
    out += s.slice(pos, vStart) + rep;
    pos = vEnd;
    KV_KEY.lastIndex = vEnd;
  }
  return out + s.slice(pos);
}

function scrubSecrets(s) {
  let out = String(s);
  for (const re of SECRETS) out = out.replace(re, MASK);
  return scrubKV(out);
}

// 이 앱은 macOS 전용 — 기본 파일 시스템이 대소문자·유니코드 정규화를 가리지 않으니 비교는 NFC 소문자로
const fold = (s) => s.normalize('NFC').toLowerCase();
const under = (p, r) => p === r || p.startsWith(r === '/' ? '/' : r + '/');

// 경로 토막의 시작(접은 글에서 찾는다). 별칭은 홈으로 펼친다
const ALIASES = ['~/', '$home/', '${home}/', '"$home"/', '"${home}"/'];
const QUOTES = '"\'`';
const STOPS = /[\s"`]/g;   // 따옴표 없는 토막이 끝나는 글자
const SPACE = /\s/;
const TRAIL = ".,;:!?)]}>'";   // 토막 끝에서만 뗀다(정규식 [..]+$ 는 긴 토막에서 되짚기가 제곱으로 는다)
const TOKEN_MAX = 4096;        // 토막마다 앞 4096자만 본다

// 글을 받아 "P·허용 폴더 밖의 홈 아래 경로가 있나"를 답하는 판정기. 홈을 모르면 판정할 수 없으니 늘 true.
// ① 시작: 접은(NFC 소문자) 글에서 홈·~/·$HOME/·${HOME}/·"$HOME"/·"${HOME}"/ 이 나오는 모든 자리(앞 글자와 상관없이), 왼쪽부터.
// ② 범위: 시작 바로 앞이 따옴표이고 같은 줄 4096자 안에 닫는 따옴표가 있으면 거기까지, 아니면 첫 공백·"·` 까지. 공백 너머로 잇지 않는다 — 단 알려진
//    루트·허용 폴더(공백이 들어 있을 수 있다)로 시작하면 그 경로 전체가 첫 부분이고 그 뒤부터 같은 규칙. 토막마다 앞 4096자.
//    끝의 .,;:!?)]}>' 만 뗀다 — 가운데 글자는 경로의 일부다.
//    시작은 앞 토막 안에 있어도 전부 따로 본다(…/viewed/bin:/home/u/other/bin). 토막 끝은 미리 한 번 재 두어 다시 훑지 않는다.
// ③ 판정: 토막 하나씩 펼치고 → posix 정규화 → resolve(실패하면 정규화한 그대로) → 루트·허용 폴더 안이 아니면 밖
function pathJudge(ctx, resolve) {
  const home = absNorm(ctx.home);
  if (home === null || home === '/') return () => true;
  const fh = fold(home);
  const allowed = [...(ctx.roots || []), ...(ctx.allowDirs || [])].map(absNorm).filter((a) => a !== null).map(fold);
  // '/.'·'//' 가 없으면 posix 정규화는 그대로다 — 긴 토막이 많을 때 그만큼 아낀다
  const norm = (t) => trimSlash(t.includes('/.') || t.includes('//') ? path.posix.normalize(t) : t);
  // lowTok = 접은 토막, srcTok = resolve 에 넘길 원래 글자 토막. 정규화는 접기와 순서를 바꿔도 같다('/'·'.' 은 안 바뀐다)
  const foreign = (lowTok, srcTok) => {
    const fn = norm(lowTok);
    const n = srcTok === lowTok ? fn : norm(srcTok);
    let r = n;
    if (resolve) {
      try { const x = resolve(n); if (typeof x === 'string' && x !== n && path.isAbsolute(x)) r = trimSlash(path.posix.normalize(x)); } catch { /* 못 풀면 정규화한 그대로 */ }
    }
    const fr = r === n ? fn : fold(r);   // 안 바뀌었으면 접은 꼴은 fn 그대로
    if (!under(fn, fh) && !under(fr, fh)) return false;   // 홈 밖 — 판정 대상이 아니다(spec §6)
    if (fr === fh) return false;                          // 홈 자체
    return !allowed.some((a) => under(fr, a));
  };
  // 홈 아래 루트·허용 폴더의 '홈 뒤' 부분 — 시작 자리에서 통째로 맞춰 본다(긴 것부터)
  const rels = [...new Set(allowed.filter((a) => a.startsWith(fh + '/')).map((a) => a.slice(fh.length)))].sort((a, b) => b.length - a.length);
  const pats = [fh, ...ALIASES];
  return (text) => {
    const s = String(text);
    const nfc = s.normalize('NFC');
    const low = nfc.toLowerCase();
    if (!pats.some((p) => low.includes(p))) return false;
    // 접어도 길이가 그대로면 자리가 맞는다 — resolve 에는 원래 글자(대소문자)를 넘긴다. 안 맞으면 접은 글자로
    const src = nfc.length === s.length && low.length === s.length ? s : low;
    const n = low.length;
    // 토막 끝을 한 번에 잰다: nextStop[i] = i 이후 첫 공백·"·` 자리, keep[i] = i 앞에서 뗄 글자가 아닌 마지막 자리 + 1
    const nextStop = new Int32Array(n + 1);
    nextStop[n] = n;
    const isStop = new Uint8Array(n);
    STOPS.lastIndex = 0;
    for (let m = STOPS.exec(low); m; m = STOPS.exec(low)) isStop[m.index] = 1;
    for (let i = n - 1; i >= 0; i--) nextStop[i] = isStop[i] ? i : nextStop[i + 1];
    const keep = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) keep[i + 1] = TRAIL.includes(low[i]) ? keep[i] : i + 1;
    const boundary = (i) => i >= n || low[i] === '/' || SPACE.test(low[i]) || TRAIL.includes(low[i]);
    const judge = (at, k) => {
      const body = k === 0 ? at + fh.length : at + pats[k].length - 1;   // 홈은 통째로, 별칭은 뒤의 '/' 부터
      const limit = Math.min(n, (k === 0 ? at : body) + TOKEN_MAX);
      const q = at > 0 ? low[at - 1] : '';
      let from = body;
      let end = -1;
      if (q && QUOTES.includes(q)) {
        // 같은 줄, 4096자 안에 닫는 따옴표가 있을 때만 거기까지가 한 경로다. 훑는 구간은 따옴표 종류마다 겹치지 않거나 4096자라 합해서 선형이다
        let p = body;
        while (p < limit && low[p] !== q && low[p] !== '\n') p++;
        if (p < limit && low[p] === q) end = p;
      }
      if (end === -1) {   // 따옴표가 없거나 안 닫혔다 — 공백·"·` 까지. 안 닫힌 따옴표로 공백 너머의 '..' 을 끌어오지 않는다
        const rel = rels.find((r) => low.startsWith(r, body) && boundary(body + r.length));
        if (rel) from = body + rel.length;
        end = Math.min(from < n ? nextStop[from] : n, limit);
      }
      const cut = Math.max(Math.min(from, end), keep[end]);
      return k === 0 ? foreign(low.slice(at, cut), src.slice(at, cut)) : foreign(fh + low.slice(body, cut), home + src.slice(body, cut));
    };
    for (let k = 0; k < pats.length; k++) {
      for (let at = low.indexOf(pats[k]); at !== -1; at = low.indexOf(pats[k], at + 1)) {
        if (judge(at, k)) return true;
      }
    }
    return false;
  };
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

// 같은 경로는 한 번만 푼다(한 발췌 안에서) — realpath 는 경로 언급마다 불리니 같은 파일이 천 번 나오면 천 번이 된다. 실패도 기억한다
function memoize(fn) {
  const seen = new Map();
  return (p) => {
    let r = seen.get(p);
    if (!r) { try { r = { v: fn(p) }; } catch (e) { r = { e }; } seen.set(p, r); }
    if ('e' in r) throw r.e;
    return r.v;
  };
}

// entries[from..to] 를 블록으로 거른다(spec §6 발췌). to 의 편집처럼 범위 안 도구의 결과는 범위 뒤에 있어도 같이 붙인다.
// ctx = { roots, home, allowDirs, resolvePath?, title? } — resolvePath 는 findWrite 와 같은 것을 넘긴다(/tmp ↔ /private/tmp)
function buildExcerpt(entries, from, to, ctx) {
  const c = ctx || {};
  const given = typeof c.resolvePath === 'function' ? memoize(c.resolvePath) : null;
  const resolve = given || path.normalize;
  const roots = Array.isArray(c.roots) ? c.roots : [];
  const list = Array.isArray(entries) ? entries : [];
  const res = results(list);
  const lo = Math.max(0, Math.trunc(Number(from)) || 0);
  const hi = Math.min(list.length - 1, Math.trunc(Number(to)));
  const blocks = [];   // { kind, keep, cap, text } — keep: 합계를 넘어도 남기는 여는 글
  for (let i = lo; i <= hi; i++) {
    const e = list[i];
    if (!e) continue;
    const when = clock(e.timestamp);
    if (e.type === 'user') {
      const t = promptText(e);   // tool_result 는 그 도구 블록에 붙는다. isMeta·자동 삽입은 뺀다
      if (t === null) continue;
      if (e.isSidechain === true) blocks.push({ kind: 'brief', keep: true, cap: EXCERPT.brief, text: `[브리프${when}]\n${t}` });
      else blocks.push({ kind: 'human', keep: true, cap: EXCERPT.human, text: `[사람${when}]\n${t}` });
      continue;
    }
    if (e.type !== 'assistant') continue;
    for (const x of items(e)) {
      if (!x) continue;
      if (x.type === 'text' && typeof x.text === 'string' && x.text.trim()) {
        blocks.push({ kind: 'text', keep: false, cap: EXCERPT.block, text: `[Claude${when}]\n${x.text}` });
      } else if (x.type === 'thinking' && typeof x.thinking === 'string' && x.thinking.trim()) {
        blocks.push({ kind: 'thinking', keep: false, cap: EXCERPT.block, text: `[Claude 생각${when}]\n${x.thinking}` });
      } else if (x.type === 'tool_use' && FILE_TOOLS.has(x.name)) {
        const p = target(x, e, resolve);
        if (p === null || !insideAny(p, roots)) continue;   // 밖이거나 모르는 대상 — 입력·결과째 뺀다
        const r = res.get(x.id);
        const body = renderInput(x.name, x.input || {});
        blocks.push({ kind: 'tool', keep: false, cap: EXCERPT.block, text: `[${x.name} ${p}${when}]${body ? `\n${body}` : ''}${r ? `\n→ ${r.text}` : ''}` });
      }
      // Bash·웹·MCP·Agent 등은 넣지 않는다
    }
  }
  // 섞인 구간: 남긴 글 전체(자르기 전)와 머리 줄에서 P 밖의 홈 경로가 보이면 세션 근거 전체를 뺀다
  const rawTitle = typeof c.title === 'string' && c.title ? c.title : null;
  const foreign = pathJudge(c, given);   // 기본(정규화만)은 토막이 이미 정규화돼 있어 부를 것이 없다
  if (blocks.some((b) => foreign(b.text)) || (rawTitle !== null && foreign(rawTitle))) return { mixed: true };

  const parts = blocks.map((b) => ({ keep: b.keep, text: cut(scrubSecrets(b.text), b.cap) }));
  const title = rawTitle !== null ? cut(scrubSecrets(rawTitle), 200) : null;
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
