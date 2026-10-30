import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { branchMatches, buildReview, markRecord, mergeStates, movedBases, type BaseMoves, type DeviceState, type Review, type ReviewItem, type Snapshot } from '@viewed/core';
import type { SyncStore } from './syncStore';

export type { SyncStatus } from './syncStore';

const CARRY_DEADLINE_MS = 5000;
const MOVES_DEADLINE_MS = 5000;

// p 를 ms 까지 기다린다. 실패·마감 초과는 null
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => null), new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); })])
    .finally(() => clearTimeout(timer));
}

// 저장·미저장 기록은 기기당 하나인 SyncStore 가 갖는다 — 이 훅은 그것을 보여 주기만 한다
export function useReview(a: { snap: Snapshot; merged: DeviceState; secret: string; store: SyncStore; others?: ReadonlyMap<string, string[]>;
  carry?: (review: Review, snap: Snapshot) => Promise<ReviewItem[]>; moves?: (from: string, to: string) => Promise<ReadonlySet<string>>;
  branches?: readonly string[] }) {
  const { store } = a;
  const own = useSyncExternalStore(store.subscribe, store.own);
  const sync = useSyncExternalStore(store.subscribe, store.status);
  const merged = useMemo(() => mergeStates([a.merged, own]), [a.merged, own]);
  // 보이는 리뷰와 그것을 만든 스냅숏을 같이 든다 — 새로고침 중엔 옛 리뷰가 남고 a.snap 만 먼저 바뀐다
  const [shown, setShown] = useState<{ review: Review; snap: Snapshot } | null>(null);

  const judged = useRef(false);                 // 이어받기 판정은 이 인스턴스가 첫 화면을 내기 전에만 한다 — 보이는 뒤엔 파일이 저절로 뒤집히지 않는다
  const waitStart = useRef<number | null>(null); // 처음 기다리기 시작한 때 — 스냅숏이 계속 들어와도 마감은 늘어나지 않는다
  const displayed = useRef(false);
  // 다른 브랜치 기록 찾기도 첫 화면 전에 한 번만. near 는 저장하지 않으니 이 인스턴스가 들고 build 마다 넘긴다
  const branched = useRef(false);
  const near = useRef<ReadonlyMap<string, string[]> | undefined>(undefined);
  // base 이동 근거: 지금 merge-base → (옛 merge-base → 바뀐 경로, null = 못 쟀다). 쌍마다 처음 물을 때 마감을 걸어 한 번 정하고
  // 이 인스턴스 안에서는 다시 묻지 않는다 — 늦은 git 이 보이는 파일을 뒤집지 않게, 스냅숏이 계속 들어와도 다시 기다리지 않게. 못 잰 쌍은 리뷰를 다시 열면 다시 잰다
  const moved = useRef(new Map<string, Map<string, ReadonlySet<string> | null>>());
  const asking = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    let live = true;   // 늦게 끝난 옛 계산이 새 상태를 덮지 못하게
    const snap = a.snap, to = snap.mergeBase, moves = a.moves;
    let from: Map<string, ReadonlySet<string> | null> | undefined;
    if (moves && to) {
      from = moved.current.get(to);
      if (!from) moved.current.set(to, from = new Map());
    }
    const mv: BaseMoves | undefined = from && to ? { to, from } : undefined;
    const build = (state: DeviceState) => buildReview(snap, state, a.secret, a.others, mv, near.current);
    // 첫 화면 전에는 base 이동 재기·다른 브랜치 기록 찾기·이어받기가 이 순서로 마감 하나를 나눠 쓴다.
    // base 이동을 먼저 — 못 재면 이 브랜치 기록이 블록 판정으로 가 옮긴 변경이 숨을 수 있다. 다른 브랜치 찾기는 못 해도 안 봄으로 남을 뿐이다
    const firstLeft = () => { waitStart.current ??= Date.now(); return Math.max(0, CARRY_DEADLINE_MS - (Date.now() - waitStart.current)); };
    (async () => {
      let state = merged;
      let r = await build(state);
      if (!live) return;
      const need = from && moves && to ? movedBases(r).filter((b) => !from.has(b)) : [];
      if (need.length) {
        const ms = displayed.current ? MOVES_DEADLINE_MS : firstLeft();
        await Promise.all(need.map((b) => {
          const k = `${b}\n${to}`;
          let p = asking.current.get(k);
          if (!p) { p = within(moves!(b, to!), ms).then((v) => { from!.set(b, v); }); asking.current.set(k, p); }
          return p;
        }));
        if (!live) return;
        r = await build(state);
        if (!live) return;
      }
      // 브랜치 이름이 바뀌어 기록이 없는 파일: diff 가 똑같으면 이 브랜치 기록으로 쓰고, 겹치면 near 로 안 본 블록만 보인다.
      // 판정은 이 실행이 살아 있을 때만 확정한다 — 취소된 실행이 판정을 먹거나 낡은 결과를 쓰지 않게
      if (a.branches?.length && !branched.current) {
        const m = await within(branchMatches(r, snap, state, a.secret, a.branches), firstLeft());
        if (!live) return;
        branched.current = true;
        near.current = m?.near;
        const recs = (m?.exact ?? []).map((it) => [it.key, markRecord(it, snap.headSha, true)] as const);
        if (recs.length) { store.setMany(recs); state = mergeStates([state, Object.fromEntries(recs)]); }
        r = await build(state);
        if (!live) return;
      }
      if (a.carry && !judged.current) {
        const left = firstLeft();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const items = await Promise.race([
          left > 0 ? a.carry(r, snap).catch(() => [] as ReviewItem[]) : Promise.resolve([] as ReviewItem[]),
          new Promise<ReviewItem[]>((res) => { timer = setTimeout(() => res([]), left); }),
        ]);
        clearTimeout(timer);
        if (!live) return;
        judged.current = true;
        if (items.length) {
          const recs = items.map((it) => [it.key, markRecord(it, snap.headSha, true)] as const);
          store.setMany(recs);
          r = await build(mergeStates([state, Object.fromEntries(recs)]));
          if (!live) return;   // 기록은 이미 써졌다 — 바뀐 merged 로 다시 도는 효과가 화면을 낸다
        }
      }
      displayed.current = true;
      setShown({ review: r, snap });
    })();
    return () => { live = false; };
  }, [a.snap, merged, a.secret, a.others, a.carry, a.moves, a.branches, store]);

  const shownHead = shown?.snap.headSha ?? a.snap.headSha;
  const toggle = useCallback((item: ReviewItem, viewed: boolean) => {
    store.set(item.key, markRecord(item, shownHead, viewed));
  }, [store, shownHead]);

  return { review: shown?.review ?? null, shownSnap: shown?.snap ?? null, toggle, sync, flush: store.flush };
}
