import { selectCarryBases, loadLocalRange, otherBranchCarry, sameResultCarry, targetCarry, type ChangedFile, type DeviceState, type NewLines, type Review, type ReviewItem, type Snapshot } from '@viewed/core';
import { localGit } from './localSource';

export type CarryContext = { state: DeviceState; secret: string; branches: readonly string[] };
// carried = 기록을 쓸 item(어디서 이어받았는지가 via), lines = 기록 없이 화면에만 쓰는 처음 보는 줄
export type CarryResult = { carried: ReviewItem[]; via: 'target' | 'branch'; lines?: NewLines };
export type CarryStep = (review: Review, snap: Snapshot, ctx: CarryContext) => Promise<CarryResult>;

// 로컬 모드: 대상을 바꿔 다시 열었을 때 이어받을 item 을 가리는 단계들. 앞 단계 결과가 뒤 단계의 시간 초과에 쓸려 가지 않게 나눠 돌린다(useReview).
// 1) 옛 대상 P 보다 뒤처진 쪽(N)으로 옮겼을 때 2) 어느 쪽으로든 결과 파일이 그대로이고 새로 볼 변경이 없을 때 3) 2 와 같은 규칙을 다른 브랜치 기록에.
// (P, head) 의 diff 는 이 함수 인스턴스 안에서만 캐시한다. 실패도 캐시(null)하고 그 P 는 건너뛴다
export function makeCarry(repo: string): readonly CarryStep[] {
  const git = localGit(repo);
  const cache = new Map<string, Promise<ChangedFile[] | null>>();
  const range = (p: string, head: string) => {
    const k = `${p}\n${head}`;
    let c = cache.get(k);
    if (!c) { c = loadLocalRange(git, p, head).catch(() => null); cache.set(k, c); }
    return c;
  };
  return [
    async (review, snap) => {
      const n = snap.mergeBase;
      if (!n) return { carried: [], via: 'target' };
      const prev: { base: string; files: ChangedFile[] }[] = [];
      for (const p of await selectCarryBases(review, n, async (p) => (await git.mergeBase(n, p)) === n)) {
        const files = await range(p, snap.headSha);
        if (files) prev.push({ base: p, files });
      }
      return { carried: prev.length ? await targetCarry(review, n, prev) : [], via: 'target' };
    },
    async (review, snap) => {
      if (!snap.mergeBase) return { carried: [], via: 'target' };
      return { ...await sameResultCarry(review, snap.mergeBase, (p) => range(p, snap.headSha)), via: 'target' };
    },
    async (review, snap, ctx) => {
      if (!ctx.branches.length) return { carried: [], via: 'branch' };
      return { ...await otherBranchCarry(review, snap, ctx.state, ctx.secret, ctx.branches, (p) => range(p, snap.headSha)), via: 'branch' };
    },
  ];
}
