const fs = require('node:fs');
const path = require('node:path');
const T = require('./transcripts.cjs');

// Claude Code 세션 저장소를 훑어 "그 줄을 쓴 편집"이 든 세션을 찾는다(spec §6 어디서·속도). 판정은 transcripts.cjs.
// 세션 기록은 읽기만 한다. 원칙: 틀린 세션보다 못 찾는 게 낫다 — 애매하면 found:false.

const READ_POOL = 4;
const MAX_FILE_BYTES = 64 * 1024 * 1024;   // 이보다 큰 기록은 건너뛴다(메모리) — 세고 보고한다
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

// 편집(to) 앞 limit 기록 안의 가장 가까운 사람 메시지 index. 없으면 -1
function humanBefore(entries, to, limit) {
  for (let i = to; i >= 0 && i > to - limit; i--) if (T.isHumanPrompt(entries[i])) return i;
  return -1;
}

// 서브에이전트 기록의 첫 user 글(컨트롤러 브리프)
function briefIndex(entries) {
  return entries.findIndex((e) => e && e.type === 'user' && e.isSidechain === true && e.isMeta !== true && e.message
    && (typeof e.message.content === 'string' ? e.message.content.trim()
      : Array.isArray(e.message.content) && !e.message.content.some((x) => x && x.type === 'tool_result')
        && e.message.content.some((x) => x && x.type === 'text' && typeof x.text === 'string' && x.text.trim())));
}

const readEntries = async (file) => T.parseJsonl((await fs.promises.readFile(file)).toString('utf8'));

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
//       now?, maxFileBytes?, stats? /* 채워 준다: { files, skipped } */ }
async function findAuthoring(a) {
  const now = typeof a.now === 'function' ? a.now : Date.now;
  const late = () => now() > a.deadline;
  const cap = Number.isFinite(a.maxFileBytes) ? a.maxFileBytes : MAX_FILE_BYTES;
  const stats = a.stats && typeof a.stats === 'object' ? a.stats : {};
  stats.files = 0;
  stats.skipped = 0;
  const timeout = { found: false, reason: 'timeout' };
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (nonBlank(text) < T.EXCERPT.minChars) return { found: false, reason: 'short-line' };
  if (late()) return timeout;

  const raw = Buffer.from(text);
  const escaped = Buffer.from(JSON.stringify(text).slice(1, -1));
  const memo = new Map();
  const resolve = (p) => { let r = memo.get(p); if (r === undefined) { r = resolvePath(p); memo.set(p, r); } return r; };
  const q = { text, side: a.side, files: (a.files || []).map((f) => (path.isAbsolute(f) ? resolve(f) : f)), until: a.until };

  const files = await collect(a.stores || [], late);
  if (late()) return timeout;
  let best = null;   // { file, key, entries, found }
  let next = 0;
  let timedOut = false;
  const worker = async () => {
    while (!timedOut) {
      const i = next++;
      if (i >= files.length) return;
      if (late()) { timedOut = true; return; }
      const { p, key } = files[i];
      try {
        const st = await fs.promises.stat(p);
        if (st.size > cap) { stats.skipped++; continue; }
        const buf = await fs.promises.readFile(p);
        stats.files++;
        if (!buf.includes(raw) && !buf.includes(escaped)) continue;
        const entries = T.parseJsonl(buf.toString('utf8'));
        const found = T.findWrite(entries, q, resolve);
        // 같은 시각이면 realpath 가 앞선 쪽 — 읽기가 끝난 순서에 결과가 달라지지 않게
        if (found && (!best || found.at > best.found.at || (found.at === best.found.at && key < best.key))) best = { file: p, key, entries, found };
      } catch { /* 못 읽는 파일은 건너뛴다 — 질문을 실패시키지 않는다 */ }
      if (late()) { timedOut = true; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_POOL, files.length) }, worker));
  if (timedOut || late()) return timeout;
  if (!best) return { found: false, reason: 'not-found' };

  const { file, key, entries, found } = best;
  const aid = T.subagentId(file);
  const ctx = { roots: a.roots, home: a.home, allowDirs: a.allowDirs, resolvePath: resolve };
  let sessionId;
  let list;
  let from;
  let to;
  if (aid === null) {
    sessionId = path.basename(file, '.jsonl');
    from = humanBefore(entries, found.index, T.EXCERPT.lookback);
    if (from === -1) return { found: false, reason: 'no-human' };
    list = entries;
    to = found.index;
  } else {
    const b = briefIndex(entries);
    if (b === -1 || b > found.index) return { found: false, reason: 'no-human' };
    list = entries.slice(b);
    to = found.index - b;
    from = 0;
    // 부모는 서브에이전트 파일의 realpath 에서 찾는다: <프로젝트>/<부모 세션>/subagents/agent-<id>.jsonl → <프로젝트>/<부모 세션>.jsonl.
    // 별칭 폴더 이름이 아니라 실제 폴더이고, 양쪽 기록의 sessionId 가 그 id 와 같을 때만 부모로 받는다
    const parentDir = path.dirname(path.dirname(key));
    const parentId = path.basename(parentDir);
    const own = [...new Set(entries.map((e) => e && e.sessionId).filter((x) => typeof x === 'string'))];
    sessionId = own.length === 1 ? own[0] : parentId;
    if (T.subagentId(key) === aid && onlySession(entries, parentId)) {
      try {
        const parent = await readEntries(`${parentDir}.jsonl`);
        if (onlySession(parent, parentId)) {
          sessionId = parentId;
          const spawn = T.findSpawn(parent, aid);
          const h = spawn === null ? -1 : humanBefore(parent, spawn, T.EXCERPT.lookback);
          if (h !== -1) { list = [parent[h], ...list]; to += 1; }
        }
      } catch { /* 부모를 못 읽으면 브리프와 편집 앞 구간만 */ }
    }
  }
  if (late()) return timeout;
  const r = T.buildExcerpt(list, from, to, { ...ctx, title: label(sessionId, found.at, aid !== null) });
  if (r.mixed) return { found: false, reason: 'mixed' };
  if (late()) return timeout;
  return { found: true, sessionId, at: found.at, subagent: aid !== null, excerpt: r.text };
}

module.exports = { sessionStores, allowDirs, resolvePath, findAuthoring };
