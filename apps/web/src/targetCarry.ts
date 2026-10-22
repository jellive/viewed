import { selectCarryBases, loadLocalRange, targetCarry, type ChangedFile, type Review, type ReviewItem, type Snapshot } from '@viewed/core';
import { localGit } from './localSource';

// 로컬 모드: 대상을 옛 대상 P 보다 뒤처진 쪽(N)으로 바꿔 열었을 때 이어받을 item 을 가린다.
// (P, head) 의 diff 는 이 함수 인스턴스 안에서만 캐시한다. 실패도 캐시(null)하고 그 P 는 건너뛴다
export function makeCarry(repo: string): (review: Review, snap: Snapshot) => Promise<ReviewItem[]> {
  const git = localGit(repo);
  const cache = new Map<string, Promise<ChangedFile[] | null>>();
  const range = (p: string, head: string) => {
    const k = `${p}\n${head}`;
    let c = cache.get(k);
    if (!c) { c = loadLocalRange(git, p, head).catch(() => null); cache.set(k, c); }
    return c;
  };
  return async (review, snap) => {
    const n = snap.mergeBase;
    if (!n) return [];
    const prev: { base: string; files: ChangedFile[] }[] = [];
    for (const p of await selectCarryBases(review, n, async (p) => (await git.mergeBase(n, p)) === n)) {
      const files = await range(p, snap.headSha);
      if (files) prev.push({ base: p, files });
    }
    return prev.length ? targetCarry(review, n, prev) : [];
  };
}
