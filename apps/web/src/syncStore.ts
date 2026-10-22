import { mergeStates, saveOwn, type DeviceState, type GitHub, type ViewRecord } from '@viewed/core';

export type SyncStatus = 'idle' | 'pending' | 'error';

export interface SyncStore {
  /** 이 기기의 최신 기록: gist 의 own ∪ 미저장 기록 */
  own(): DeviceState;
  status(): SyncStatus;
  subscribe(fn: () => void): () => void;
  /** loadAll 로 읽은 own 을 합친다 — 로컬 기록을 버리지 않는다 */
  absorb(remoteOwn: DeviceState): void;
  /** 체크/해제를 기록한다. 미저장 기록은 동기로 남기고 1.5초 뒤 저장을 예약한다 */
  set(key: string, rec: ViewRecord): void;
  /** set 을 여러 건 한 번에 — 복사·저장·알림이 각각 한 번이다 */
  setMany(entries: readonly (readonly [string, ViewRecord])[]): void;
  /** 지금 보낸다. 저장 큐가 빌 때까지 기다린다 */
  flush(): Promise<void>;
}

// gist 마다 따로 둔다 — 다른 gist 의 저장소가 이 기록을 지우지 못하게
const pendingKey = (gistId: string, deviceId: string) => `viewed.pending.${gistId}.${deviceId}`;
function readPending(gistId: string, deviceId: string): DeviceState {
  try { return JSON.parse(localStorage.getItem(pendingKey(gistId, deviceId)) ?? '{}'); } catch { return {}; }
}

// gist 의 기기 파일과 pending 키는 기기당 하나다 — 그 쓰기도 기기당 하나(이 저장소)만 한다
const stores = new Map<string, SyncStore & { gh: GitHub }>();

export function getSyncStore(gh: GitHub, gistId: string, deviceId: string): SyncStore {
  const id = `${gistId}\n${deviceId}`;
  const found = stores.get(id);
  if (found) { found.gh = gh; return found; }
  const s = create(gh, gistId, deviceId);
  stores.set(id, s);
  return s;
}

function create(gh0: GitHub, gistId: string, deviceId: string): SyncStore & { gh: GitHub } {
  let own: DeviceState = readPending(gistId, deviceId);           // 만들 때 동기로 읽는다 — 옛 저장이 지운 뒤에 읽는 일이 없게
  let version = Object.keys(own).length ? 1 : 0;          // 마지막 변경 번호
  let savedVersion = 0;                                    // 마지막으로 gist 에 저장된 번호
  let inflight = false, failed = false, absorbed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();            // 저장은 한 번에 하나씩
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());

  const store: SyncStore & { gh: GitHub } = {
    gh: gh0,
    own: () => own,
    status: () => (failed ? 'error' : inflight || version !== savedVersion ? 'pending' : 'idle'),
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    absorb(remote) {
      own = mergeStates([remote, own]);                    // 로컬이 더 새로우면 로컬이 이긴다
      absorbed = true;
      emit();
      if (version !== savedVersion) void store.flush();     // 열기 전부터 남아 있던 미저장 기록
    },
    set(key, rec) { store.setMany([[key, rec]]); },
    setMany(entries) {
      if (!entries.length) return;
      own = { ...own, ...Object.fromEntries(entries) };
      version += 1;
      try { localStorage.setItem(pendingKey(gistId, deviceId), JSON.stringify(own)); } catch { failed = true; }
      emit();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void store.flush(); }, 1500);   // spec §6: 1.5초 모아서
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      chain = chain.then(async () => {
        // 읽기 전의 own 으로 gist 파일을 덮어쓰면 기록이 지워진다 — absorb 전에는 보내지 않는다
        if (!absorbed || version === savedVersion) return;
        const v = version, body = own;                       // 보내는 시점의 최신
        inflight = true; emit();
        try {
          await saveOwn(store.gh, gistId, deviceId, body);
          savedVersion = v; failed = false;
          if (v === version) { try { localStorage.removeItem(pendingKey(gistId, deviceId)); } catch { /* 다음 저장에서 다시 지운다 */ } }
        } catch { failed = true; }
        inflight = false; emit();
      });
      return chain;
    },
  };

  if (typeof document !== 'undefined') {                    // spec §6: 화면을 떠날 때 즉시
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && version !== savedVersion) void store.flush();
    });
  }
  return store;
}

// 동기화 없이 이 기기에만 둔다(settings.storage === 'device'). 아무것도 기기 밖으로 안 나간다
const deviceStores = new Map<string, SyncStore>();
export function getDeviceStore(deviceId: string): SyncStore {
  const found = deviceStores.get(deviceId);
  if (found) return found;
  const key = `viewed.device.${deviceId}`;
  let own: DeviceState = (() => { try { return JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { return {}; } })();
  let st: SyncStatus = 'idle';
  const subs = new Set<() => void>();
  const store: SyncStore = {
    own: () => own,
    status: () => st,
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    absorb: () => {},
    set: (k, rec) => store.setMany([[k, rec]]),
    setMany: (entries) => {
      if (!entries.length) return;
      own = { ...own, ...Object.fromEntries(entries) };
      try { localStorage.setItem(key, JSON.stringify(own)); st = 'idle'; } catch { st = 'error'; }
      subs.forEach((f) => f());
    },
    flush: async () => {},
  };
  deviceStores.set(deviceId, store);
  return store;
}
