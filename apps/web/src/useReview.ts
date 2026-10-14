import { useCallback, useEffect, useRef, useState } from 'react';
import { buildReview, markRecord, saveOwn, type DeviceState, type GitHub, type Review, type ReviewItem, type Snapshot } from '@viewed/core';

export type SyncStatus = 'idle' | 'pending' | 'error';

// 저장 못 한 기록을 기기에 남겨 둔다 — 실패 후 앱을 닫아도 체크가 사라지지 않게
const pendingKey = (deviceId: string) => `viewed.pending.${deviceId}`;
export function readPending(deviceId: string): DeviceState {
  try { return JSON.parse(localStorage.getItem(pendingKey(deviceId)) ?? '{}'); } catch { return {}; }
}

export function useReview(a: { snap: Snapshot; merged: DeviceState; own: DeviceState; secret: string; gh: GitHub; gistId: string; deviceId: string }) {
  // a.own 에는 open() 이 readPending 을 이미 합쳐 넣었다
  const [merged, setMerged] = useState(a.merged);
  const own = useRef<DeviceState>({ ...a.own });   // 비동기 저장이 읽으므로 호출 시점에 동기 갱신
  const version = useRef(0);                        // 마지막 변경 번호
  const chain = useRef<Promise<void>>(Promise.resolve());   // 저장은 한 번에 하나씩
  const [review, setReview] = useState<Review | null>(null);
  const [sync, setSync] = useState<SyncStatus>(Object.keys(readPending(a.deviceId)).length ? 'pending' : 'idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;   // 늦게 끝난 옛 계산이 새 상태를 덮지 못하게
    buildReview(a.snap, merged, a.secret).then((r) => { if (live) setReview(r); });
    return () => { live = false; };
  }, [a.snap, merged, a.secret]);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const v = version.current;
    const body = own.current;
    // 앞 저장이 끝난 뒤에 보낸다 — 늦게 도착한 옛 PATCH 가 새 기록을 덮지 못하게
    chain.current = chain.current.then(async () => {
      try {
        await saveOwn(a.gh, a.gistId, a.deviceId, body);
        if (v === version.current) { localStorage.removeItem(pendingKey(a.deviceId)); setSync('idle'); }
      } catch { setSync('error'); }
    });
    return chain.current;
  }, [a.gh, a.gistId, a.deviceId]);

  const toggle = useCallback((item: ReviewItem, viewed: boolean) => {
    const rec = markRecord(item, a.snap.headSha, viewed);
    own.current = { ...own.current, [item.key]: rec };
    version.current += 1;
    localStorage.setItem(pendingKey(a.deviceId), JSON.stringify(own.current));
    setMerged((m) => ({ ...m, [item.key]: rec }));
    setSync('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1500);           // spec §6: 1.5초 모아서
  }, [a.snap.headSha, a.deviceId, flush]);

  useEffect(() => {                                     // 열 때 남아 있던 미저장 기록을 다시 보낸다
    if (Object.keys(readPending(a.deviceId)).length) void flush();
  }, [a.deviceId, flush]);

  useEffect(() => {                                     // spec §6: 화면을 떠날 때 즉시
    const onHide = () => { if (document.visibilityState === 'hidden' && timer.current) void flush(); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      if (timer.current) void flush();                  // 다른 브랜치를 열어 화면이 바뀔 때도 예약된 저장을 보낸다
    };
  }, [flush]);

  return { review, toggle, sync, flush };
}
