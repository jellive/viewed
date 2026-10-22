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

  const carried = useRef<Snapshot | null>(null);   // 이어받기 판정을 끝낸 스냅숏 — 같은 스냅숏에선 다시 하지 않는다(기록을 쓰면 merged 가 바뀌어 이 효과가 또 돈다)

  useEffect(() => {
    let live = true;   // 늦게 끝난 옛 계산이 새 상태를 덮지 못하게
    const snap = a.snap;
    (async () => {
      const r = await buildReview(snap, merged, a.secret, a.others);
      if (!live) return;
      if (a.carry && carried.current !== snap) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const items = await Promise.race([
          a.carry(r, snap).catch(() => [] as ReviewItem[]),
          new Promise<ReviewItem[]>((res) => { timer = setTimeout(() => res([]), CARRY_DEADLINE_MS); }),
        ]);
        clearTimeout(timer);
        if (!live) return;
        carried.current = snap;
        if (items.length) {
          // 기록을 쓰면 merged 가 바뀌어 이 효과가 다시 돌고, 그때 이어받은 파일이 반영된 리뷰가 처음 보인다
          for (const it of items) store.set(it.key, markRecord(it, snap.headSha, true));
          return;
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
