import { useEffect, useRef, useState } from 'react';
import { GitHub, loadLocalSnapshot, loadSnapshot, loadAll, mergeStates, meMatcher, othersOf, repoIdFromRemote, type Author, type DeviceState, type Snapshot } from '@viewed/core';
import { loadSettings, type Settings as S } from './settings';
import { Settings } from './components/Settings';
import { ReviewView } from './components/ReviewView';
import { getDeviceStore, getSyncStore, type SyncStore } from './syncStore';
import { errorText, t } from './i18n';
import { LocalOpen } from './components/LocalOpen';
import { desktopGit, localAuthors, localBlob, localGit } from './localSource';
import { readRecent, rememberGithub, rememberLocal } from './recent';

type ReadBlob = (sha: string) => Promise<string | null>;
// head: 로컬 모드에서 브랜치 끝 커밋을 싸게 읽는다 — 바뀌면 자동으로 다시 읽는다
// repo: 로컬로 연 리뷰의 폴더 — 줄에 질문하기(+)는 이게 있는 리뷰에만(폼의 소스 버튼이 아니라 연 리뷰를 따른다)
type Made = { snap: Snapshot; readBlob: ReadBlob; head?: () => Promise<string>; repo?: string;
  // 남의 변경만 닿은 파일(경로 → 작성자 이름)과 '나' 판정 — 로컬 모드만
  others?: ReadonlyMap<string, string[]>; isMe?: (a: Author) => boolean };
type Make = () => Promise<Made>;
const LIVE_MS = 3000;
const AUTHORS_GRACE_MS = 1500;
// 작성자 판정이 무엇으로든 던지면 맵만 버린다 — 목록 읽기는 실패시키지 않는다
const safeOthers = (f: () => Map<string, string[]>) => { try { return { others: f() }; } catch { return {}; } };
// 기기 저장 기록은 기기 밖으로 안 나가 이름을 감출 필요가 없다 — 고정 키라 공유 비밀을 바꿔도 기록이 그대로 찾아진다
const DEVICE_SECRET = 'viewed-device';

export function App() {
  const [settings, setSettings] = useState<S | null | undefined>(undefined);
  // 마지막으로 연 리뷰 — 켤 때 한 번 읽어 소스·GitHub 칸을 채운다
  const [last] = useState(() => readRecent().last);
  const [form, setForm] = useState(() => last?.source === 'github'
    ? { account: last.account, repo: last.repo, branch: last.branch, base: last.base } : { account: '', repo: '', branch: '', base: '' });
  const [loaded, setLoaded] = useState<{ id: number; snap: Snapshot; merged: DeviceState; store: SyncStore; readBlob: ReadBlob; make: Make; head?: () => Promise<string>; repo?: string; others?: ReadonlyMap<string, string[]>; isMe?: (a: Author) => boolean } | null>(null);
  const [source, setSource] = useState<'github' | 'local'>(() => (desktopGit() && last?.source !== 'github' ? 'local' : 'github'));
  // 마지막 로컬 리뷰를 켤 때 한 번 자동으로 여는 권한. 실행당 1회라 App 이 든다 — 설정·소스 전환으로 LocalOpen 이 다시 마운트돼도 다시 안 준다
  const auto = useRef(last?.source === 'local' ? last : undefined);
  const [error, setError] = useState('');
  // 로컬 열기가 성공해 최근 목록이 바뀌면 오른다 — LocalOpen 이 목록을 다시 읽는다
  const [recentRev, setRecentRev] = useState(0);
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const seq = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  // 다시 읽을 때 자격 증명은 그때의 설정에서 꺼낸다 — 열 때 잡아 둔 토큰은 교체된 뒤에도 남는다
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // 로컬 모드: 열린 브랜치에 새 커밋이 생기면 버튼 없이 다시 읽는다(일찍 반환하는 분기보다 위에 둔다 — 훅 순서)
  useEffect(() => {
    const head = loaded?.head;
    if (!head) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      // 다시 읽기가 끝날 때까지 기다린다 — 3초보다 오래 걸려도 겹쳐 시작해 앞선 결과를 버리지 않게
      try { if ((await head()) !== loaded.snap.headSha) await refreshRef.current(); } catch { /* 다음 주기에 다시 본다 */ } finally { busy = false; }
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [loaded]);
  const pendingRefresh = useRef(false);
  useEffect(() => {
    if (pendingRefresh.current && settings && !editing) { pendingRefresh.current = false; refreshRef.current(); }
  }, [settings, editing]);
  useEffect(() => {
    loadSettings().then(setSettings).catch(() => { setLoadError(t.storedUnreadable); setSettings(null); });
  }, []);
  if (settings === undefined) return null;
  // 토큰·비밀이 비어 있으면(첫 실행 또는 keychain 복호화 실패) 설정으로 보낸다 — spec §7 재입력
  const device = settings?.storage === 'device';
  const incomplete = !settings || (!device && !settings.secret) || settings.accounts.some((a) => !a.token)
    || (device ? settings.accounts.length === 0 && !desktopGit()
      : settings.accounts.length === 0 || !settings.accounts.some((a) => a.label === settings.gistAccount));
  if (incomplete || editing) return <Settings initial={settings} notice={loadError} onSaved={(s) => {
    // gist 나 기기가 바뀌면 옛 저장소에 묶인 화면은 버린다 — 다시 열면 새 저장소를 쓴다
    // '나' 이름이 바뀌면 열린 리뷰를 다시 판정한다(설정이 반영된 다음 렌더에서 — 아래 effect)
    const norm = (x?: string[]) => (x ?? []).map((v) => v.trim().toLowerCase()).join('\n');
    if (loaded && norm(s.extraMe) !== norm(settings?.extraMe)) pendingRefresh.current = true;
    if (settings && (s.gistId !== settings.gistId || s.deviceId !== settings.deviceId || s.storage !== settings.storage)) { seq.current++; setLoaded(null); }
    setSettings(s); setEditing(false);
  }} />;

  const token = (label: string) => settings.accounts.find((a) => a.label === label)?.token ?? '';
  // 스냅샷을 만드는 방법만 소스마다 다르고, 체크 기록(gist)을 붙이는 뒷부분은 같다
  // refresh: 보던 화면을 지우지 않고 그 자리에서 바꾼다(같은 id 라 필터·스크롤이 남는다)
  // remember: 이 요청이 화면에 올라갔을 때 그 요청의 값으로 기록한다 — 폼의 지금 값이 아니다. 다시 읽기는 기록하지 않는다
  async function load(make: Make, refresh = false, remember?: () => void) {
    const mine = ++seq.current;
    setError(''); if (!refresh) setLoaded(null);
    const keep = (id: number) => (refresh && loaded ? loaded.id : id);
    try {
      const { snap, readBlob, head, repo, others, isMe } = await make();
      if (settings!.storage === 'device') {
        const store = getDeviceStore(settings!.deviceId);
        if (mine !== seq.current) return;
        setLoaded({ id: keep(mine), snap, merged: store.own(), store, readBlob, make, head, repo, others, isMe });
        remember?.();
        return;
      }
      const gistGh = new GitHub(token(settings!.gistAccount));
      const all = await loadAll(gistGh, settings!.gistId, settings!.deviceId);
      // 쓰기는 기기당 하나인 저장소가 한다 — 읽은 own 을 합치고, 화면에는 로컬 기록까지 얹는다
      const store = getSyncStore(gistGh, settings!.gistId, settings!.deviceId);
      store.absorb(all.own);
      const merged = mergeStates([all.merged, store.own()]);
      if (mine !== seq.current) return;
      setLoaded({ id: keep(mine), snap, merged, store, readBlob, make, head, repo, others, isMe });
      remember?.();
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorText(e));
    }
  }
  refreshRef.current = async () => { if (loaded) await load(loaded.make, true); };
  function open() {
    const repoStr = form.repo.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoStr)) { setError(t.repoShape); return; }
    if (!form.branch.trim()) { setError(t.branchRequired); return; }
    // 기억해 둔 계정이 지금 설정에 없으면 첫 계정으로
    const label = settings!.accounts.some((a) => a.label === form.account) ? form.account : settings!.accounts[0].label;
    const branch = form.branch.trim(), base = form.base;
    load(async () => {
      const [owner, repo] = repoStr.split('/');
      const now = () => settingsRef.current?.accounts.find((a) => a.label === label)?.token ?? '';
      const gh = new GitHub(now());
      const snap = await loadSnapshot(gh, owner, repo, branch, base || undefined);
      return { snap, readBlob: (sha) => gh.blobText(owner, repo, sha) };
    }, false, () => rememberGithub(label, repoStr, branch, base));
  }
  // 마지막 소스가 GitHub 여도 계정이 없으면 쓸 수 없다 — 로컬 폴더
  const localForm = source === 'local' || settings.accounts.length === 0;
  return (
    <main className="app">
      {desktopGit() && settings.accounts.length > 0 && (
        <div className="source" role="group" aria-label={t.source}>
          <button type="button" data-testid="source-github" aria-pressed={source === 'github'} onClick={() => setSource('github')}>GitHub</button>
          <button type="button" data-testid="source-local" aria-pressed={source === 'local'} onClick={() => setSource('local')}>{t.sourceLocal}</button>
        </div>
      )}
      {localForm ? (
        <form data-testid="open-form" className="open-bar" onSubmit={(e) => e.preventDefault()}>
          <LocalOpen onError={setError} onCancel={() => { seq.current++; }} recentRev={recentRev} takeAuto={() => { const a = auto.current; auto.current = undefined; return a; }} onOpen={(repo, info, branch, base) => load(async () => {
            const git = localGit(repo);
            // 스냅숏과 작성자 목록을 나란히 읽는다(둘 다 ~1초) — 그 사이 브랜치가 움직였으면 작성자는 버린다
            // 미리 읽기가 실패하면 작성자만 포기한다 — 오류는 스냅숏 읽기가 같은 말로 낸다
            let head = '', mb = '';
            try { head = await git.resolve(branch); const baseSha = await git.resolve(base); mb = head && baseSha ? await git.mergeBase(baseSha, head) : ''; } catch { /* 위 */ }
            const pending = mb ? localAuthors(repo, mb, head) : Promise.resolve(null);
            const snap = await loadLocalSnapshot(git, repoIdFromRemote(info.remote, repo), branch, base);
            // 스냅숏이 끝난 뒤 작성자를 최대 1.5초만 더 기다린다 — 늦으면 전부 내 것으로 그리고 넘어간다
            const authors = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), AUTHORS_GRACE_MS))]);
            // '나' = git 사용자(이름·이메일) + 설정의 추가분. 다시 읽을 때마다 그때의 설정으로 다시 계산한다
            const isMe = meMatcher([info.user?.name ?? '', info.user?.email ?? '', ...(settingsRef.current?.extraMe ?? [])]);
            const fresh = authors && snap.headSha === head && snap.mergeBase === mb;
            return {
              snap, readBlob: localBlob(repo), head: () => git.resolve(branch), repo, isMe,
              ...(fresh ? safeOthers(() => othersOf(snap.files, authors.files, isMe, authors.renames)) : {}),
            };
          }, false, () => { rememberLocal(repo, branch, base); setRecentRev((n) => n + 1); })} />
          <button type="button" data-testid="settings-open" onClick={() => setEditing(true)}>{t.settings}</button>
        </form>
      ) : (
      <form data-testid="open-form" className="open-bar" onSubmit={(e) => { e.preventDefault(); open(); }}>
        <select data-testid="account-select" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })}>
          {settings.accounts.map((a) => <option key={a.label}>{a.label}</option>)}</select>
        <input data-testid="repo-input" placeholder={t.repoPlaceholder} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} />
        <input data-testid="branch-input" placeholder={t.branchPlaceholder} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
        <input data-testid="base-input" placeholder={t.basePlaceholder} value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} />
        <button data-testid="open-btn" className="primary">{t.open}</button>
        <button type="button" data-testid="settings-open" onClick={() => setEditing(true)}>{t.settings}</button>
      </form>
      )}
      {localForm && <p className="hint">{t.localFetchHint}</p>}
      {error && <p data-testid="error" role="alert" className="flash err">{error}</p>}
      {loaded && (
        <ReviewView key={loaded.id} snap={loaded.snap} merged={loaded.merged} secret={device ? DEVICE_SECRET : settings.secret} store={loaded.store} readBlob={loaded.readBlob} onRefresh={() => refreshRef.current()} live={!!loaded.head} askRepo={loaded.repo} others={loaded.others} isMe={loaded.isMe} />
      )}
    </main>
  );
}
