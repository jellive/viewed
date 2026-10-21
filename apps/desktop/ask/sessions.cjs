const fs = require('node:fs');
const path = require('node:path');
const T = require('./transcripts.cjs');

// Claude Code 세션 저장소를 훑어 "그 줄을 쓴 편집"이 든 세션을 찾는다(spec §6 어디서·속도). 판정은 transcripts.cjs.
// 세션 기록은 읽기만 한다. 원칙: 틀린 세션보다 못 찾는 게 낫다 — 애매하면 found:false.

const READ_POOL = 4;
// 기록은 통째로 읽지 않는다(수백 MiB 짜리가 있다). 청크로 흘려 읽고, 줄·창 크기에 상한을 둔다. 모두 a.* 로 덮을 수 있다
const CHUNK = 4 * 1024 * 1024;
const LINE_MAX = 16 * 1024 * 1024;         // 이보다 긴 줄은 파싱하지 않는다 — 줄에 찾는 글이 들어 있으면 'unreadable'
const WINDOW_LINE_MAX = 1024 * 1024;       // 발췌 창 안에 이보다 긴 줄이 있으면 검사할 수 없으니 'mixed'
const WINDOW_TOTAL_MAX = 32 * 1024 * 1024; // 창 전체 바이트 상한(넘으면 같은 이유로 'mixed')
const LOOK = T.EXCERPT.lookback;
const LATE = Symbol('late');
const nonBlank = (s) => s.replace(/\s/g, '').length;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// [$CLAUDE_CONFIG_DIR/projects (비어 있지 않으면), home/.claude/projects] 중 있는 것. realpath 로 돌려주고 중복은 뺀다
function sessionStores(env, home) {
  const cfg = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  const cands = [];
  if (cfg) cands.push(path.join(cfg, 'projects'));
  if (home) cands.push(path.join(home, '.claude', 'projects'));
  const out = [];
  for (const c of cands) {
    const r = isDir(c) ? real(c) : null;
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

// 허용 폴더(realpath): 임시 폴더·/tmp·home/.claude·$CLAUDE_CONFIG_DIR(비어 있지 않으면). 없는 것은 뺀다
function allowDirs(env, home) {
  const cfg = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  const out = [];
  for (const c of [require('node:os').tmpdir(), '/tmp', home ? path.join(home, '.claude') : '', cfg]) {
    const r = c ? real(c) : null;
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

// 가장 깊이 있는 조상의 realpath + 남은 토막(정규화). 지워진 파일도 /tmp → /private/tmp 처럼 같은 곳으로 간다
function resolvePath(p) {
  const n = path.normalize(p);
  let cur = n;
  const rest = [];
  for (;;) {
    const r = real(cur);
    if (r !== null) return rest.length ? path.join(r, ...rest.reverse()) : r;
    const up = path.dirname(cur);
    if (up === cur) return n;
    rest.push(path.basename(cur));
    cur = up;
  }
}

// 저장소들 아래 *.jsonl 을 재귀로(심볼릭 링크를 따라간다). 경로는 보이는 그대로 두고(서브에이전트 구조 판별) 모든 파일을 realpath 로 중복 제거한다.
// late() 가 참이면 거기서 멈춘다(마감)
async function collect(stores, late) {
  const files = [];   // { p, key }
  const seen = new Set();
  const walk = async (dir) => {
    const key = real(dir);
    if (key === null || seen.has(key)) return;
    seen.add(key);
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (late()) return;
      const p = path.join(dir, e.name);
      let isD = e.isDirectory();
      let isF = e.isFile();
      if (e.isSymbolicLink()) {
        try { const st = fs.statSync(p); isD = st.isDirectory(); isF = st.isFile(); } catch { continue; }
      }
      if (isD) await walk(p);
      else if (isF && e.name.endsWith('.jsonl')) {
        const k = real(p);
        if (k !== null && !seen.has(k)) { seen.add(k); files.push({ p, key: k }); }
      }
    }
  };
  for (const s of stores) { if (late()) break; await walk(s); }
  return files;
}

// --- 흘려 읽기 -----------------------------------------------------------------------------------------------------------

const has = (buf, needles) => needles.some((n) => buf.indexOf(n) !== -1);
const lastBytes = (buf, k) => (k <= 0 ? Buffer.alloc(0) : Buffer.from(buf.length > k ? buf.subarray(buf.length - k) : buf));
const bump = (o, n) => { if (n > o.stats.peakBytes) o.stats.peakBytes = n; };

// 0단계: 청크 경계를 걸치는 것까지 포함해 needle 이 한 번이라도 나오나. 메모리는 청크 하나. true | false | LATE
async function prefilter(file, needles, o) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(o.chunk);
    const nk = Math.max(...needles.map((n) => n.length)) - 1;
    bump(o, o.chunk);
    let carry = Buffer.alloc(0);
    for (let pos = 0; ;) {
      if (o.late()) return LATE;
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) return false;
      pos += bytesRead;
      const view = buf.subarray(0, bytesRead);
      if (has(view, needles)) return true;
      if (carry.length && has(Buffer.concat([carry, view.subarray(0, Math.min(bytesRead, nk))]), needles)) return true;
      carry = lastBytes(carry.length && bytesRead < nk ? Buffer.concat([carry, view]) : view, nk);
    }
  } finally { await fh.close(); }
}

// 줄 단위로 흘린다. onLine(idx, line, hit, off, len) — 동기. line 은 그 줄(개행 제외) 또는, lineMax 를 넘으면 null.
// hit = 그 줄에 needle 이 들었나(청크 경계를 걸쳐도). off/len = 파일 안 바이트 위치. 끝까지 읽으면 undefined, 마감이면 LATE
async function eachLine(file, needles, o, onLine, range) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(o.chunk);
    const nk = needles.length ? Math.max(...needles.map((n) => n.length)) - 1 : 0;
    const lim = range ? range.end : Infinity;   // range = { start, end } 바이트 범위만 흘린다(줄 번호는 범위 안에서 0부터)
    let parts = [];
    let partsLen = 0;
    let lineLen = 0;
    let lineOff = 0;
    let started = false;
    let hit = false;
    let tail = Buffer.alloc(0);
    let idx = 0;
    const reset = () => { parts = []; partsLen = 0; lineLen = 0; started = false; hit = false; tail = Buffer.alloc(0); idx++; };
    const emit = (piece) => {
      const over = lineLen > o.lineMax;
      const line = over ? null : (parts.length ? Buffer.concat([...parts, piece]) : piece);
      if (line) bump(o, o.chunk + 2 * line.length);
      onLine(idx, line, hit, lineOff, lineLen);
      reset();
    };
    for (let pos = range ? range.start : 0; ;) {
      if (o.late()) return LATE;
      const want = Math.min(buf.length, lim - pos);
      if (want <= 0) break;
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      const view = buf.subarray(0, bytesRead);
      let start = 0;
      while (start < bytesRead) {
        const nl = view.indexOf(10, start);
        const end = nl === -1 ? bytesRead : nl;
        const piece = view.subarray(start, end);
        if (!started) { started = true; lineOff = pos + start; hit = has(piece, needles); }
        else if (!hit) hit = has(piece, needles) || (tail.length > 0 && has(Buffer.concat([tail, piece.subarray(0, nk)]), needles));
        lineLen += piece.length;
        if (nl !== -1) { emit(piece); start = nl + 1; continue; }
        // 줄이 다음 청크로 이어진다
        tail = lastBytes(tail.length && piece.length < nk ? Buffer.concat([tail, piece]) : piece, nk);
        if (lineLen <= o.lineMax) { parts.push(Buffer.from(piece)); partsLen += piece.length; bump(o, o.chunk + partsLen); } else parts = [];
        start = bytesRead;
      }
      pos += bytesRead;
    }
    if (started) emit(Buffer.alloc(0));   // 개행 없이 끝난 마지막 줄 — 모은 조각이 줄 전체다
  } finally { await fh.close(); }
}

async function readRange(file, start, len, o) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.allocUnsafe(len);
    bump(o, len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(b, got, len - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return b.subarray(0, got);
  } finally { await fh.close(); }
}

// 범위 [start,end) 의 줄 목록(내용은 안 들고 있는다): { rel, off, len, over, human }. human = 사람이 친 메시지(windowLineMax 이하 줄만 파싱해 판정)
async function lineMeta(file, start, end, o) {
  const lines = [];
  const r = await eachLine(file, [], o, (idx, line, hit, off, len) => {
    const over = line === null || len > o.windowLineMax;
    let human = false;
    if (!over && line.indexOf(BRIEF_MARK) !== -1) { const e = tryParse(line); human = !!e && T.isHumanPrompt(e); }
    lines.push({ rel: idx, off, len, over, human });
  }, { start, end });
  return r === LATE ? LATE : lines;
}

// 렌더할 범위 [fromOff, end) 를 읽어 파싱한다. 총 바이트가 windowTotalMax 를 넘으면 null
async function readEntries(file, fromOff, end, o) {
  if (end - fromOff > o.windowTotalMax) return null;
  return T.parseJsonl((await readRange(file, fromOff, end - fromOff, o)).toString('utf8'));
}

const tryParse = (line) => { try { const e = JSON.parse(line.toString('utf8')); return e && typeof e === 'object' && !Array.isArray(e) ? e : null; } catch { return null; } };
const WRITE_NAMES = new Set(['Edit', 'MultiEdit', 'Write']);
const contentItems = (e) => (e && e.message && Array.isArray(e.message.content) ? e.message.content : []);
const BRIEF_MARK = Buffer.from('"type":"user"');
const AGENT_MARK = Buffer.from('"name":"Agent"');
const RESULT_MARK = Buffer.from('"type":"tool_result"');
const WRITE_MARKS = ['Edit', 'MultiEdit', 'Write'].map((n) => Buffer.from(`"name":"${n}"`));
const ERR_MARKS = [Buffer.from('"is_error":true'), Buffer.from('<tool_use_error>')];
const textOfContent = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '');

// 결과의 toolUseResult 를 findWrite 가 쓰는 만큼만 남긴다: 그 줄(want)과 같은 '+'/'-' 줄(과 hunk 번호), Write 새 파일은 맞는 줄만.
// 두 번째 값 = 맞는 줄이 있었나. 객체가 아니면 [undefined, false]
function stripTur(tur, want) {
  if (!tur || typeof tur !== 'object' || Array.isArray(tur)) return [undefined, false];
  const out = { type: tur.type };
  let any = false;
  if (Array.isArray(tur.structuredPatch)) {
    out.structuredPatch = tur.structuredPatch.map((h) => {
      if (!h || !Array.isArray(h.lines)) return { lines: null };   // findWrite 가 모양이 이상하다고 보게 그대로 둔다
      const lines = h.lines.filter((l) => typeof l === 'string' && (l[0] === '+' || l[0] === '-') && l.slice(1).trim() === want);
      if (lines.length) any = true;
      return { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines };
    });
  }
  if (tur.type === 'create' && typeof tur.content === 'string') {
    const lines = tur.content.split('\n').filter((l) => l.trim() === want);
    if (lines.length) any = true;
    out.content = lines.join('\n');
  }
  return [out, any];
}

// 한 파일의 1단계: 줄을 흘리며 findWrite 에 필요한 것만 남긴다(줄 번호 _i 보존).
//  - 쓰기 도구(Edit·MultiEdit·Write) 호출 줄은 찾는 글이 입력에 있든 없든 전부 — 입력은 버리고 id·file_path 만. 부분 줄 치환이나 Write 갱신은 입력에 줄이 없다
//  - 결과 줄은 남긴 호출의 것이고(찾는 글이 있거나 오류) 쓴 줄이 맞거나 오류일 때만 — 조각만 남긴다. 나머지(Read 결과·큰 originalFile)는 버린다
// 반환: { cand, unreadable, brief } | LATE. cand = { at, editIdx, win, resEnd }
async function judgeFile(p, key, needles, q, resolve, o) {
  const isSub = T.subagentId(key) !== null;
  const want = q.text;
  const small = [];
  const wins = new Map();   // 호출 줄 번호 → { startIdx, startOff }
  const keptIds = new Set();
  const ring = new Float64Array(LOOK);
  let unreadable = false;
  let brief = null;
  let briefLost = false;
  let kept = 0;
  const keep = (e, extra) => { small.push(e); kept += JSON.stringify(e).length + extra; if (kept > o.stats.keptBytes) o.stats.keptBytes = kept; };
  const r = await eachLine(p, needles, o, (idx, line, hit, off, len) => {
    let e = null;
    if (isSub && brief === null && !briefLost) {
      if (line === null) briefLost = true;   // 첫 user 글일 수 있는 줄을 못 읽었다 — 다음 user 글을 브리프로 삼지 않는다
      else if (line.indexOf(BRIEF_MARK) !== -1) {
        e = tryParse(line);
        if (e && isBrief(e)) brief = { e, idx, len };
      }
    }
    if (line === null) { if (hit) unreadable = true; }
    else if (WRITE_MARKS.some((m) => line.indexOf(m) !== -1)) {
      e = e || tryParse(line);
      const uses = e && e.type === 'assistant'
        ? contentItems(e).filter((x) => x && x.type === 'tool_use' && WRITE_NAMES.has(x.name) && typeof x.id === 'string' && x.input && typeof x.input.file_path === 'string') : [];
      if (uses.length) {
        const s0 = Math.max(0, idx - LOOK);
        wins.set(idx, { startIdx: s0, startOff: idx === 0 ? 0 : ring[s0 % LOOK] });
        for (const x of uses) keptIds.add(x.id);
        keep({ type: 'assistant', message: { content: uses.map((x) => ({ type: 'tool_use', id: x.id, name: x.name, input: { file_path: x.input.file_path } })) }, _i: idx }, 48);
      }
    } else if (keptIds.size && line.indexOf(RESULT_MARK) !== -1 && (hit || ERR_MARKS.some((m) => line.indexOf(m) !== -1))) {
      e = e || tryParse(line);
      const items = e && e.type === 'user' ? contentItems(e).filter((x) => x && x.type === 'tool_result' && typeof x.tool_use_id === 'string') : [];
      if (items.some((x) => keptIds.has(x.tool_use_id))) {
        let err = false;
        const content = items.map((x) => {
          const t = textOfContent(x.content);
          const bad = x.is_error === true || t.trimStart().startsWith('<tool_use_error>');
          err = err || bad;
          return { type: 'tool_result', tool_use_id: x.tool_use_id, ...(x.is_error === true ? { is_error: true } : {}), ...(bad && t.trimStart().startsWith('<tool_use_error>') ? { content: t.slice(0, 200) } : {}) };
        });
        const [tur, matches] = stripTur(e.toolUseResult, want);
        if (err || matches) keep({ type: 'user', timestamp: e.timestamp, message: { content }, ...(tur ? { toolUseResult: tur } : {}), _i: idx, _off: off, _len: len }, 0);
      }
    }
    ring[idx % LOOK] = off;
  });
  if (r === LATE) return LATE;
  const found = T.findWrite(small, q, resolve);
  let cand = null;
  if (found) {
    const use = small[found.index];
    const res = small.find((e) => e.type === 'user' && contentItems(e).some((x) => x.tool_use_id === found.toolUseId));
    const win = use && wins.get(use._i);
    if (win && res) cand = { at: found.at, editIdx: use._i, win, resEnd: res._off + res._len };
  }
  return { cand, unreadable, brief: brief && { ...brief }, briefLost };
}

// 서브에이전트의 부모 세션 파일에서 그 에이전트를 띄운 호출 앞의 사람 메시지. 못 찾거나 못 믿으면 null (브리프와 편집 앞 구간만 쓴다).
// 검증: 읽은 기록들의 sessionId 가 전부 parentId 이고 하나 이상 있어야 한다.
// 찾은 사람 메시지 뒤(호출 앞)에 windowLineMax 를 넘는 줄이 있으면 그것이 더 새 사람 메시지일 수 있어 null. 그 메시지보다 앞의 긴 줄은 상관없다.
// 반환: entry | null | LATE
async function parentPrompt(file, aid, parentId, o) {
  const id = Buffer.from(aid);
  if (await prefilter(file, [id], o) !== true) return null;
  const small = [];
  const ring = new Float64Array(LOOK);
  let lost = false;
  const r = await eachLine(file, [id], o, (idx, line, hit, off, len) => {
    if (line === null) { if (hit) lost = true; ring[idx % LOOK] = off; return; }
    let e = null;
    if (line.indexOf(AGENT_MARK) !== -1) {
      e = tryParse(line);
      if (e && e.type === 'assistant') {
        const uses = contentItems(e).filter((x) => x && x.type === 'tool_use' && x.name === 'Agent' && typeof x.id === 'string');
        if (uses.length) {
          const s0 = Math.max(0, idx - LOOK);
          small.push({ type: 'assistant', sessionId: e.sessionId, _i: idx, _off: off, _win: { startIdx: s0, startOff: idx === 0 ? 0 : ring[s0 % LOOK] },
            message: { content: uses.map((x) => ({ type: 'tool_use', id: x.id, name: 'Agent' })) } });
        }
      }
    }
    if (hit) {
      e = e && e.type === 'user' ? e : tryParse(line);
      if (e && e.type === 'user') { e._i = idx; small.push(e); }
    }
    ring[idx % LOOK] = off;
  });
  if (r === LATE) return LATE;
  if (lost) return null;
  small.sort((x, y) => x._i - y._i);
  const spawn = T.findSpawn(small, aid);
  if (spawn === null) return null;
  const use = small[spawn];
  const meta = await lineMeta(file, use._win.startOff, use._off, o);
  if (meta === LATE || o.late()) return LATE;
  let h = -1;
  for (let i = meta.length - 1; i >= 0; i--) if (meta[i].human) { h = i; break; }
  if (h === -1 || meta.slice(h + 1).some((l) => l.over)) return null;
  const hl = meta[h];
  const got = await readEntries(file, hl.off, hl.off + hl.len, o);
  if (o.late()) return LATE;
  const prompt = got && got.find((e) => T.isHumanPrompt(e));
  if (!prompt) return null;
  if (!onlySession([...small, prompt], parentId)) return null;
  return prompt;
}

// 서브에이전트 기록의 첫 user 글(컨트롤러 브리프)인가
const isBrief = (e) => !!e && e.type === 'user' && e.isSidechain === true && e.isMeta !== true && !!e.message
  && (typeof e.message.content === 'string' ? !!e.message.content.trim()
    : Array.isArray(e.message.content) && !e.message.content.some((x) => x && x.type === 'tool_result')
      && e.message.content.some((x) => x && x.type === 'text' && typeof x.text === 'string' && x.text.trim()));

function label(sid, at, subagent) {
  const d = new Date(at);
  const p = (v) => String(v).padStart(2, '0');
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `세션 ${sid.slice(0, 8)}${subagent ? ' (서브에이전트)' : ''}, ${when}, 오래된→최근`;
}

// 기록 안 sessionId 들이 정확히 want 하나뿐일 때만 참
const onlySession = (entries, want) => {
  const ids = new Set(entries.map((e) => e && e.sessionId).filter((x) => typeof x === 'string'));
  return ids.size === 1 && ids.has(want);
};

// a = { stores, text, side, files, roots, until, home, allowDirs, deadline /* epoch ms */,
//       now?, stats? /* 채워 준다: { files, peakBytes } */, chunkBytes?, lineMax?, windowLineMax?, windowTotalMax? }
// 결과 reason: short-line | not-found | mixed | no-human | timeout | unreadable
async function findAuthoring(a) {
  const now = typeof a.now === 'function' ? a.now : Date.now;
  const late = () => now() > a.deadline;
  const stats = a.stats && typeof a.stats === 'object' ? a.stats : {};
  stats.files = 0;
  stats.peakBytes = 0;
  stats.keptBytes = 0;
  const timeout = { found: false, reason: 'timeout' };
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (nonBlank(text) < T.EXCERPT.minChars) return { found: false, reason: 'short-line' };
  if (late()) return timeout;

  const raw = Buffer.from(text);
  const escaped = Buffer.from(JSON.stringify(text).slice(1, -1));
  const needles = raw.equals(escaped) ? [raw] : [raw, escaped];
  const nmax = Math.max(raw.length, escaped.length);
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const o = { late, stats, chunk: Math.max(num(a.chunkBytes, CHUNK), nmax + 1), lineMax: num(a.lineMax, LINE_MAX),
    windowLineMax: num(a.windowLineMax, WINDOW_LINE_MAX), windowTotalMax: num(a.windowTotalMax, WINDOW_TOTAL_MAX) };
  const memo = new Map();
  const resolve = (p) => { let r = memo.get(p); if (r === undefined) { r = resolvePath(p); memo.set(p, r); } return r; };
  // 후보 파일은 realpath 가 루트(realpath) 안인 것만 — 워크트리의 파일이 다른 레포로 가는 심볼릭 링크면 그 레포의 편집이 후보가 된다.
  // 대상 파일이 어느 루트에도 안 들어가면 찾지 않는다(mixed)
  const roots = (a.roots || []).filter((r) => typeof r === 'string' && path.isAbsolute(r)).map(resolve);
  const given = (a.files || []).filter((f) => typeof f === 'string' && path.isAbsolute(f));
  const targets = given.map(resolve).filter((f) => T.insideAny(f, roots));
  if (given.length && !targets.length) return { found: false, reason: 'mixed' };
  const q = { text, side: a.side, files: targets, until: a.until };

  const files = await collect(a.stores || [], late);
  if (late()) return timeout;
  let best = null;   // { file, key, ...cand, brief }
  let unreadable = false;
  let next = 0;
  let timedOut = false;
  const worker = async () => {
    while (!timedOut) {
      const i = next++;
      if (i >= files.length) return;
      if (late()) { timedOut = true; return; }
      const { p, key } = files[i];
      try {
        const hit = await prefilter(p, needles, o);
        stats.files++;
        if (hit === LATE) { timedOut = true; return; }
        if (!hit) continue;
        const r = await judgeFile(p, key, needles, q, resolve, o);
        if (r === LATE) { timedOut = true; return; }
        if (r.unreadable) unreadable = true;
        const c = r.cand;
        // 같은 시각이면 realpath 가 앞선 쪽 — 읽기가 끝난 순서에 결과가 달라지지 않게
        if (c && (!best || c.at > best.at || (c.at === best.at && key < best.key))) best = { file: p, key, ...c, brief: r.brief, briefLost: r.briefLost };
      } catch { /* 못 읽는 파일은 건너뛴다 — 질문을 실패시키지 않는다 */ }
      if (late()) { timedOut = true; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_POOL, files.length) }, worker));
  if (timedOut || late()) return timeout;
  if (unreadable) return { found: false, reason: 'unreadable' };   // 찾는 글이 든 줄을 못 읽었다 — 틀린 세션을 고르느니 안 고른다
  if (!best) return { found: false, reason: 'not-found' };

  const { key, editIdx, win } = best;
  const aid = T.subagentId(key);
  const ctx = { roots: a.roots, home: a.home, allowDirs: a.allowDirs, resolvePath: resolve };
  // 렌더할 범위: 사람 메시지(서브에이전트는 브리프)부터 편집 결과까지. 그 앞의 줄은 렌더되지 않으니 길어도 상관없고, 범위 안의 긴 줄은 검사할 수 없어 mixed
  let meta;
  try { meta = await lineMeta(key, win.startOff, best.resEnd, o); } catch { return { found: false, reason: 'not-found' }; }
  if (meta === LATE || late()) return timeout;
  const editRel = editIdx - win.startIdx;
  const b = best.brief;
  let startRel = -1;
  if (aid === null) {
    for (const l of meta) if (l.human && l.rel <= editRel) startRel = l.rel;
    if (startRel === -1) return { found: false, reason: 'no-human' };
  } else {
    if (!b || b.idx > editIdx) return { found: false, reason: 'no-human' };
    if (b.len > o.windowLineMax) return { found: false, reason: 'mixed' };
    startRel = b.idx >= win.startIdx ? b.idx - win.startIdx : 0;
  }
  const startLine = meta.find((l) => l.rel === startRel);
  if (!startLine) return { found: false, reason: 'not-found' };
  if (meta.some((l) => l.rel >= startRel && l.over)) return { found: false, reason: 'mixed' };
  let entries;
  try { entries = await readEntries(key, startLine.off, best.resEnd, o); } catch { return { found: false, reason: 'not-found' }; }
  if (late()) return timeout;
  if (entries === null) return { found: false, reason: 'mixed' };   // 창이 windowTotalMax 를 넘는다
  const to0 = entries.findIndex((e) => e._i === editRel - startRel);
  if (to0 === -1) return { found: false, reason: 'not-found' };
  let sessionId;
  let list;
  let from = 0;
  let to;
  if (aid === null) {
    sessionId = path.basename(key, '.jsonl');
    list = entries;
    to = to0;
  } else {
    const inWin = b.idx >= win.startIdx;   // 브리프가 범위 첫 줄이면 그대로, 앞이면 따로 붙인다
    list = inWin ? entries : [b.e, ...entries];
    to = inWin ? to0 : to0 + 1;
    // 부모는 서브에이전트 파일의 realpath 에서 찾는다: <프로젝트>/<부모 세션>/subagents/agent-<id>.jsonl → <프로젝트>/<부모 세션>.jsonl.
    // 별칭 폴더 이름이 아니라 실제 폴더이고, 읽은 기록들의 sessionId 가 그 id 와 같을 때만 부모로 받는다
    const parentDir = path.dirname(path.dirname(key));
    const parentId = path.basename(parentDir);
    const own = [...new Set([b.e, ...entries].map((e) => e && e.sessionId).filter((x) => typeof x === 'string'))];
    sessionId = own.length === 1 ? own[0] : parentId;
    if (onlySession([b.e, ...entries], parentId)) {
      let prompt = null;
      try { prompt = await parentPrompt(`${parentDir}.jsonl`, aid, parentId, o); } catch { /* 부모를 못 읽으면 브리프와 편집 앞 구간만 */ }
      if (prompt === LATE || late()) return timeout;
      if (prompt) { sessionId = parentId; list = [prompt, ...list]; to += 1; }
    }
  }
  const r = T.buildExcerpt(list, from, to, { ...ctx, title: label(sessionId, best.at, aid !== null) });
  if (r.mixed) return { found: false, reason: 'mixed' };
  if (late()) return timeout;
  return { found: true, sessionId, at: best.at, subagent: aid !== null, excerpt: r.text };
}

module.exports = { sessionStores, allowDirs, resolvePath, findAuthoring };
