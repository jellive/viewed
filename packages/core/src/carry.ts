import { fingerprint } from './fingerprint';
import { recordKey } from './keys';
import { unmatchedBlocks } from './blocks';
import type { ChangedFile, DeviceState, Review, ReviewItem, Snapshot, ViewRecord } from './types';

const MAX_CHECKED = 10, MAX_USED = 3;

// 이어받을 후보 P: 확인한 기록이 가장 많이 걸린 base 순(동수면 문자열 오름차순). 조상 검사 전의 후보라 넉넉히 10개까지
export function carryBases(review: Review, n: string): string[] {
  const count = new Map<string, number>();
  for (const i of review.items) {
    const r = i.record;
    if (r?.viewed && r.base && r.base !== n) count.set(r.base, (count.get(r.base) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, MAX_CHECKED).map(([b]) => b);
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
    let ok = false, prevOf: { base: string; fp: string } | undefined;
    for (const s of sets) {
      if (!s.touched.has(item.file.path) && !(item.file.previousPath !== undefined && s.touched.has(item.file.previousPath))) { ok = true; break; }
      const r = item.record, pf = s.byPath.get(item.file.path);
      if (r?.viewed && r.base === s.base && pf && await fingerprint(pf) === r.fp) { ok = true; prevOf = { base: r.base, fp: r.fp }; break; }
    }
    if (ok) out.push(prevOf ? { ...item, carryPrev: prevOf } : item);
  }
  return out;
}

// 기록 키에 브랜치가 들어 브랜치 이름이 바뀌면 기록을 하나도 못 찾는다. 이 브랜치에 기록이 없고 남 표시도 없는 파일마다
// 다른 브랜치(branches — 같은 레포의 ref 이름)에서 같은 경로를 확인한 기록을 찾는다.
// exact = diff 가 그때 본 것과 똑같다 / near = 아니면 변경 블록이 하나라도 겹치는 기록 중 가장 최근 것의 블록(경로별).
// 어느 쪽이든 가장 최근 기록이 확인일 때만 — 다른 브랜치에서 나중에 푼 것이 그 전의 확인보다 이긴다.
// patch 없는 파일(바이너리·서브모듈)의 지문은 결과 blob 뿐이라 base 가 같아야 같은 변경이다
export async function branchMatches(review: Review, snap: Snapshot, state: DeviceState, secret: string, branches: readonly string[]):
  Promise<{ exact: ReviewItem[]; near: Map<string, string[]> }> {
  const names = [...new Set(branches)].filter((b) => b !== snap.branch);
  const exact: ReviewItem[] = [], near = new Map<string, string[]>();
  for (const item of review.items) {
    if (item.record || item.others) continue;
    let same: ViewRecord | undefined, best: ViewRecord | undefined;
    const newer = (r: ViewRecord, than?: ViewRecord) => !than || Date.parse(r.at) > Date.parse(than.at);
    for (const b of names) {
      const r = state[await recordKey(secret, snap.owner, snap.repo, b, item.file.path)];
      if (!r) continue;
      if (r.fp === item.fp && (item.file.patch !== undefined || r.base === snap.mergeBase)) { if (newer(r, same)) same = r; }
      else if (r.blocks && item.blocks && newer(r, best) && unmatchedBlocks(r.blocks, item.blocks).length < item.blocks.length) best = r;
    }
    if (same) { if (same.viewed) exact.push(item); }
    else if (best?.viewed && best.blocks) near.set(item.file.path, best.blocks);
  }
  return { exact, near };
}
