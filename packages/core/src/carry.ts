import { fingerprint } from './fingerprint';
import { recordKey } from './keys';
import { unmatchedBlocks } from './blocks';
import type { ChangedFile, DeviceState, NearMatch, NewLines, Review, ReviewItem, Snapshot, ViewRecord } from './types';

const MAX_CHECKED = 10, MAX_USED = 3;

// 이어받을 후보 P: 확인한 기록이 가장 많이 걸린 base 순(동수면 문자열 오름차순). 조상 검사 전의 후보라 넉넉히 10개까지
export function carryBases(review: Review, n: string): string[] {
  const count = new Map<string, number>();
  for (const i of review.items) {
    const r = i.record;
    if (r?.viewed && r.base && r.base !== n) count.set(r.base, (count.get(r.base) ?? 0) + 1);
    if (r?.viewed && r.prev && r.prev.base !== n) count.set(r.prev.base, (count.get(r.prev.base) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, MAX_CHECKED).map(([b]) => b);
}

// 결과 파일 줄 번호로 편 변경: 추가한 줄(결과 파일 번호 → patch 줄 번호)과, 블록마다 결과 파일에서 차지한 구간(from~to)·지운 줄. hunk 머리를 못 읽으면 null
interface PlacedBlock { from: number; to: number; removed: { at: number; text: string; line: number }[] }
function placeChanges(patch: string): { added: Map<number, number>; blocks: PlacedBlock[] } | null {
  const added = new Map<number, number>(), blocks: PlacedBlock[] = [];
  let at = 0, cur: PlacedBlock | null = null, prev: string | undefined;
  for (const [i, line] of patch.split('\n').entries()) {
    const c = line[0];
    if (line.startsWith('@@')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      if (!h) return null;
      at = Number(h[1]);
      cur = null;
    } else if (c === '-' || c === '+') {
      if (!cur) { cur = { from: at, to: at, removed: [] }; blocks.push(cur); }
      if (c === '+') { added.set(at, i); cur.to = ++at; }
      else cur.removed.push({ at, text: line, line: i });
    } else if (c === '\\') {
      // 끝 개행 표시는 지운 줄의 일부다. 추가 줄에 붙은 표시는 결과 파일이 같으니 볼 것이 없다
      if (prev === '-' && cur) cur.removed[cur.removed.length - 1].text += `\n${line}`;
    } else {
      if (c === ' ') at++;
      cur = null;
    }
    prev = c;
  }
  return { added, blocks };
}

// 지금 diff 의 변경 중 그때 본 diff 의 같은 자리에 없던 것의 patch 줄 번호. 빈 배열 = 전부 본 것, null = 못 읽었다. 결과 파일이 같아야 줄 번호를 맞댈 수 있다.
// 추가 줄은 같은 번호, 지운 줄은 그때 그 글자를 지운 블록의 구간 안 — 대상이 블록 일부를 이미 가지면 지운 줄의 자리가 그 구간 안에서 밀린다.
// 글자만 맞대면 다른 함수에서 같은 글자를 지운 것이 숨는다
function unseenLines(now: string, seen: string): number[] | null {
  const c = placeChanges(now), s = placeChanges(seen);
  if (!c || !s) return null;
  const out: number[] = [];
  for (const [n, line] of c.added) if (!s.added.has(n)) out.push(line);
  const left = s.blocks.map((b) => {
    const m = new Map<string, number>();
    for (const r of b.removed) m.set(r.text, (m.get(r.text) ?? 0) + 1);
    return m;
  });
  for (const b of c.blocks) for (const r of b.removed) {
    const i = s.blocks.findIndex((v) => v.from <= r.at && r.at <= v.to);
    const n = i < 0 ? 0 : left[i].get(r.text) ?? 0;
    if (n) left[i].set(r.text, n - 1);
    else out.push(r.line);
  }
  return out.sort((x, y) => x - y);
}

// 결과 파일이 기록과 같은 파일들을 그때 본 diff 와 맞댄다. load(P) = P..head diff. 그 파일의 지문이 기록과 같아야 '그때 본 diff' 다.
// 근거가 결과 파일이 같다는 것이라 대상의 조상 관계도, 어느 브랜치에서 봤는지도 안 본다.
// 후보가 많은 옛 대상 순으로 최대 3개만 읽는다(동수면 문자열 오름차순). 못 읽은 대상의 파일은 그대로 둔다
async function compareWithViewed<T extends { item: ReviewItem; rec: ViewRecord }>(cands: T[], load: (base: string) => Promise<ChangedFile[] | null>): Promise<{ seen: T[]; lines: NewLines }> {
  const count = new Map<string, number>();
  for (const { rec } of cands) count.set(rec.base!, (count.get(rec.base!) ?? 0) + 1);
  const bases = [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, MAX_USED).map(([b]) => b);
  const viewed = new Map<string, Map<string, ChangedFile>>();
  for (const b of bases) {
    const files = await load(b).catch(() => null);
    if (files) viewed.set(b, new Map(files.map((f) => [f.path, f])));
  }
  const seen: T[] = [], lines = new Map<string, { fp: string; lines: number[] }>();
  for (const c of cands) {
    const f = c.item.file, pf = viewed.get(c.rec.base!)?.get(f.path);
    if (pf?.patch === undefined || await fingerprint(pf) !== c.rec.fp) continue;
    if (pf.previousPath !== f.previousPath || pf.mode !== f.mode) continue;
    // 지금 diff 에 mode 변경이 있으면 그때 본 변경이어야 한다 — 결과 mode 만 맞대면 대상의 실행 권한을 없애는 변경이 숨는다
    if (f.oldMode !== f.mode && f.oldMode !== pf.oldMode) continue;
    const fresh = unseenLines(f.patch!, pf.patch);
    if (fresh?.length === 0) seen.push(c);
    else if (fresh) lines.set(f.path, { fp: c.item.fp, lines: fresh });
  }
  return { seen, lines };
}

// 대상을 옮겨 diff 만 달라진 파일: 결과 파일이 확인 때 그대로이고 지금 변경이 전부 그때 본 변경이면 새로 볼 것이 없다. 처음 보는 줄이 있으면 그 줄을 알려 준다
export async function sameResultCarry(review: Review, n: string, load: (base: string) => Promise<ChangedFile[] | null>): Promise<{ carried: ReviewItem[]; lines: NewLines }> {
  const cands = review.items.flatMap((item) => (item.state !== 'viewed' && item.file.patch !== undefined && item.record?.viewed
    && item.record.base && item.record.base !== n && item.record.blob === item.file.blobSha ? [{ item, rec: item.record }] : []));
  const { seen, lines } = await compareWithViewed(cands, load);
  return { carried: seen.map(({ item, rec }) => ({ ...item, carryPrev: { base: rec.base!, fp: rec.fp, ...(rec.via ? { via: rec.via } : {}) } })), lines };
}

// 같은 규칙을 다른 브랜치 기록에: 이 브랜치에 기록이 아예 없는 파일(체크를 푼 기록이 있으면 그것이 이긴다)만, 결과 파일이 같은 기록 중 가장 최근 것이 확인일 때.
// 결과 파일이 다른 기록의 체크 풀기는 이 내용에 대한 판단이 아니라 보지 않는다
export async function otherBranchCarry(review: Review, snap: Snapshot, state: DeviceState, secret: string, branches: readonly string[], load: (base: string) => Promise<ChangedFile[] | null>): Promise<{ carried: ReviewItem[]; lines: NewLines }> {
  const names = [...new Set(branches)].filter((b) => b !== snap.branch);
  const cands: { item: ReviewItem; rec: ViewRecord }[] = [];
  for (const item of review.items) {
    if (item.record || item.state === 'viewed' || item.file.patch === undefined) continue;
    let best: ViewRecord | undefined;
    for (const b of names) {
      const r = state[await recordKey(secret, snap.owner, snap.repo, b, item.file.path)];
      if (r && r.blob === item.file.blobSha && (!best || Date.parse(r.at) > Date.parse(best.at))) best = r;
    }
    if (best?.viewed && best.base && best.base !== snap.mergeBase) cands.push({ item, rec: best });
  }
  const { seen, lines } = await compareWithViewed(cands, load);
  return { carried: seen.map(({ item }) => item), lines };
}

// 후보 중 N 의 후손인 것만 기록 수 순으로 최대 3개. 조상 검사가 던지면 그 P 는 건너뛴다
export async function selectCarryBases(review: Review, n: string, isAncestor: (p: string) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  for (const p of carryBases(review, n)) {
    if (out.length >= MAX_USED) break;
    try { if (p !== n && await isAncestor(p)) out.push(p); } catch { /* 이 P 는 건너뛴다 */ }
  }
  return out;
}

// 대상을 옛 대상 P 로 바꿔 연 리뷰에서 확인함으로 칠 item. P 가 N 의 후손인지는 호출자가 이미 확인했다.
// (a) P-diff 쪽 path·previousPath 어디에도 이 파일의 path·previousPath 가 없다 = 옛 대상과 같다  (b) P 기준으로 확인했고 P-diff 의 지문이 기록과 같다
export async function targetCarry(review: Review, n: string, prev: { base: string; files: ChangedFile[] }[]): Promise<ReviewItem[]> {
  const cands = review.items.filter((i) => i.state !== 'viewed' && !i.others && i.record?.viewed !== false && i.record?.base !== n);
  const sets = prev.map((p) => {
    const touched = new Set<string>(), byPath = new Map<string, ChangedFile>();
    for (const f of p.files) {
      touched.add(f.path); if (f.previousPath !== undefined) touched.add(f.previousPath);
      byPath.set(f.path, f);
    }
    return { base: p.base, touched, byPath };
  });
  const out: ReviewItem[] = [];
  for (const item of cands) {
    let ok = false, prevOf: ReviewItem['carryPrev'];
    for (const s of sets) {
      if (!s.touched.has(item.file.path) && !(item.file.previousPath !== undefined && s.touched.has(item.file.previousPath))) { ok = true; break; }
      const r = item.record, pf = s.byPath.get(item.file.path);
      if (!r?.viewed || !pf) continue;
      if (r.base === s.base && await fingerprint(pf) === r.fp) { ok = true; prevOf = { base: r.base, fp: r.fp, ...(r.via ? { via: r.via } : {}) }; break; }
      // 앞서 이어받아 다시 쓴 기록 — 처음 확인한 대상은 prev 에 있다. 대상을 두 번 건너면 다시 쓴 base 는 조상이 아닐 수 있다
      if (r.prev?.base === s.base && await fingerprint(pf) === r.prev.fp) { ok = true; prevOf = r.prev; break; }
    }
    if (ok) out.push(prevOf ? { ...item, carryPrev: prevOf } : item);
  }
  return out;
}

// 기록 키에 브랜치가 들어 브랜치 이름이 바뀌면 기록을 하나도 못 찾는다. 이 브랜치에 기록이 없고 남 표시도 없는 파일마다
// 다른 브랜치(branches — 같은 레포의 ref 이름)에서 같은 경로를 확인한 기록을 찾는다.
// exact = diff 가 그때 본 것과 똑같다 / near = 아니면 변경 블록이 하나라도 겹치는 기록 중 가장 최근 것의 블록(경로별).
// 양쪽 다 새 파일이면 블록을 안 본다 — diff 전체가 블록 하나라 한 줄만 달라도 안 겹친다. base 쪽이 비어 blob 비교에 소음이 없으니 그때의 blob 으로 줄을 맞댄다.
// 어느 쪽이든 가장 최근 기록이 확인일 때만 — 다른 브랜치에서 나중에 푼 것이 그 전의 확인보다 이긴다.
// patch 없는 파일(바이너리·서브모듈)의 지문은 결과 blob 뿐이라 base 가 같아야 같은 변경이다
export async function branchMatches(review: Review, snap: Snapshot, state: DeviceState, secret: string, branches: readonly string[]):
  Promise<{ exact: ReviewItem[]; near: Map<string, NearMatch> }> {
  const names = [...new Set(branches)].filter((b) => b !== snap.branch);
  const exact: ReviewItem[] = [], near = new Map<string, NearMatch>();
  for (const item of review.items) {
    if (item.record || item.others) continue;
    let same: ViewRecord | undefined, best: ViewRecord | undefined;
    const newer = (r: ViewRecord, than?: ViewRecord) => !than || Date.parse(r.at) > Date.parse(than.at);
    const bothNew = (r: ViewRecord) => item.file.status === 'added' && item.file.patch !== undefined && r.meta === item.meta && !!r.blob;
    const overlaps = (r: ViewRecord) => !!r.blocks && !!item.blocks && unmatchedBlocks(r.blocks, item.blocks).length < item.blocks.length;
    for (const b of names) {
      const r = state[await recordKey(secret, snap.owner, snap.repo, b, item.file.path)];
      if (!r) continue;
      if (r.fp === item.fp && (item.file.patch !== undefined || r.base === snap.mergeBase)) { if (newer(r, same)) same = r; }
      else if (newer(r, best) && (bothNew(r) || overlaps(r))) best = r;
    }
    if (same) { if (same.viewed) exact.push(item); }
    else if (best?.viewed) near.set(item.file.path, bothNew(best) ? { blob: best.blob! } : { blocks: best.blocks! });
  }
  return { exact, near };
}
