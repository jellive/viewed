import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildReview, markRecord, mergeStates, type DeviceState, type Review, type ReviewItem, type Snapshot } from '@viewed/core';
import type { SyncStore } from './syncStore';

export type { SyncStatus } from './syncStore';

const CARRY_DEADLINE_MS = 5000;

// 저장·미저장 기록은 기기당 하나인 SyncStore 가 갖는다 — 이 훅은 그것을 보여 주기만 한다
export function useReview(a: { snap: Snapshot; merged: DeviceState; secret: string; store: SyncStore; others?: ReadonlyMap<string, string[]>;
  carry?: (review: Review, snap: Snapshot) => Promise<ReviewItem[]> }) {
  const { store } = a;
  const own = useSyncExternalStore(store.subscribe, store.own);
  const sync = useSyncExternalStore(store.subscribe, store.status);
  const merged = useMemo(() => mergeStates([a.merged, own]), [a.merged, own]);
  // 보이는 리뷰와 그것을 만든 스냅숏을 같이 든다 — 새로고침 중엔 옛 리뷰가 남고 a.snap 만 먼저 바뀐다
  const [shown, setShown] = useState<{ review: Review; snap: Snapshot } | null>(null);

  const judged = useRef(false);                 // 이어받기 판정은 이 인스턴스가 첫 화면을 내기 전에만 한다 — 보이는 뒤엔 파일이 저절로 뒤집히지 않는다
  const waitStart = useRef<number | null>(null); // 처음 기다리기 시작한 때 — 스냅숏이 계속 들어와도 마감은 늘어나지 않는다

  useEffect(() => {
    let live = true;   // 늦게 끝난 옛 계산이 새 상태를 덮지 못하게
    const snap = a.snap;
    (async () => {
      let r = await buildReview(snap, merged, a.secret, a.others);
      if (!live) return;
      if (a.carry && !judged.current) {
        waitStart.current ??= Date.now();
        const left = Math.max(0, CARRY_DEADLINE_MS - (Date.now() - waitStart.current));
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
          r = await buildReview(snap, mergeStates([merged, Object.fromEntries(recs)]), a.secret, a.others);
          if (!live) return;   // 기록은 이미 써졌다 — 바뀐 merged 로 다시 도는 효과가 화면을 낸다
        }
      }
      setShown({ review: r, snap });
    })();
    return () => { live = false; };
  }, [a.snap, merged, a.secret, a.others, a.carry, store]);

  const shownHead = shown?.snap.headSha ?? a.snap.headSha;
  const toggle = useCallback((item: ReviewItem, viewed: boolean) => {
    store.set(item.key, markRecord(item, shownHead, viewed));
  }, [store, shownHead]);

  return { review: shown?.review ?? null, shownSnap: shown?.snap ?? null, toggle, sync, flush: store.flush };
}
