import { fingerprint } from './fingerprint';
import type { ChangedFile, Review, ReviewItem } from './types';

// 이어받을 후보 P: 확인한 기록이 가장 많이 걸린 base 순(동수면 문자열 오름차순), 최대 3개
export function carryBases(review: Review, n: string): string[] {
  const count = new Map<string, number>();
  for (const i of review.items) {
    const r = i.record;
    if (r?.viewed && r.base && r.base !== n) count.set(r.base, (count.get(r.base) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 3).map(([b]) => b);
}

// 대상을 옛 대상 P 로 바꿔 연 리뷰에서 확인함으로 칠 item. P 가 N 의 후손인지는 호출자가 이미 확인했다.
// (a) P-diff 에 경로(path·previousPath)가 없다 = 옛 대상과 같다  (b) P 기준으로 확인했고 P-diff 의 지문이 기록과 같다
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
    let ok = false;
    for (const s of sets) {
      if (!s.touched.has(item.file.path)) { ok = true; break; }
      const r = item.record, pf = s.byPath.get(item.file.path);
      if (r?.viewed && r.base === s.base && pf && await fingerprint(pf) === r.fp) { ok = true; break; }
    }
    if (ok) out.push(item);
  }
  return out;
}
