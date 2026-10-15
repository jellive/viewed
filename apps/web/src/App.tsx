import { useEffect, useRef, useState } from 'react';
import { GitHub, loadLocalSnapshot, loadSnapshot, loadAll, mergeStates, repoIdFromRemote, type DeviceState, type Snapshot } from '@viewed/core';
import { loadSettings, type Settings as S } from './settings';
import { Settings } from './components/Settings';
import { ReviewView } from './components/ReviewView';
import { getDeviceStore, getSyncStore, type SyncStore } from './syncStore';
import { errorText, t } from './i18n';
import { LocalOpen } from './components/LocalOpen';
import { desktopGit, localBlob, localGit } from './localSource';

type ReadBlob = (sha: string) => Promise<string | null>;
// 기기 저장 기록은 기기 밖으로 안 나가 이름을 감출 필요가 없다 — 고정 키라 공유 비밀을 바꿔도 기록이 그대로 찾아진다
const DEVICE_SECRET = 'viewed-device';

export function App() {
  const [settings, setSettings] = useState<S | null | undefined>(undefined);
  const [form, setForm] = useState({ account: '', repo: '', branch: '', base: '' });
  const [loaded, setLoaded] = useState<{ id: number; snap: Snapshot; merged: DeviceState; store: SyncStore; readBlob: ReadBlob } | null>(null);
  const [source, setSource] = useState<'github' | 'local'>(() => (desktopGit() ? 'local' : 'github'));
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const seq = useRef(0);
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
    if (settings && (s.gistId !== settings.gistId || s.deviceId !== settings.deviceId || s.storage !== settings.storage)) { seq.current++; setLoaded(null); }
    setSettings(s); setEditing(false);
  }} />;

  const token = (label: string) => settings.accounts.find((a) => a.label === label)?.token ?? '';
  // 스냅샷을 만드는 방법만 소스마다 다르고, 체크 기록(gist)을 붙이는 뒷부분은 같다
  async function load(make: () => Promise<{ snap: Snapshot; readBlob: ReadBlob }>) {
    const mine = ++seq.current;
    setError(''); setLoaded(null);
    try {
      const { snap, readBlob } = await make();
      if (settings!.storage === 'device') {
        const store = getDeviceStore(settings!.deviceId);
        if (mine !== seq.current) return;
        setLoaded({ id: mine, snap, merged: store.own(), store, readBlob });
        return;
      }
      const gistGh = new GitHub(token(settings!.gistAccount));
      const all = await loadAll(gistGh, settings!.gistId, settings!.deviceId);
      // 쓰기는 기기당 하나인 저장소가 한다 — 읽은 own 을 합치고, 화면에는 로컬 기록까지 얹는다
      const store = getSyncStore(gistGh, settings!.gistId, settings!.deviceId);
      store.absorb(all.own);
      const merged = mergeStates([all.merged, store.own()]);
      if (mine !== seq.current) return;
      setLoaded({ id: mine, snap, merged, store, readBlob });
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorText(e));
    }
  }
  function open() {
    const repoStr = form.repo.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoStr)) { setError(t.repoShape); return; }
    if (!form.branch.trim()) { setError(t.branchRequired); return; }
    load(async () => {
      const [owner, repo] = repoStr.split('/');
      const gh = new GitHub(token(form.account || settings!.accounts[0].label));
      const snap = await loadSnapshot(gh, owner, repo, form.branch.trim(), form.base || undefined);
      return { snap, readBlob: (sha) => gh.blobText(owner, repo, sha) };
    });
  }
  return (
    <main className="app">
      {desktopGit() && settings.accounts.length > 0 && (
        <div className="source" role="group" aria-label={t.source}>
          <button type="button" data-testid="source-github" aria-pressed={source === 'github'} onClick={() => setSource('github')}>GitHub</button>
          <button type="button" data-testid="source-local" aria-pressed={source === 'local'} onClick={() => setSource('local')}>{t.sourceLocal}</button>
        </div>
      )}
      {source === 'local' || settings.accounts.length === 0 ? (
        <form data-testid="open-form" className="open-bar" onSubmit={(e) => e.preventDefault()}>
          <LocalOpen onError={setError} onOpen={(repo, info, branch, base) => load(async () => ({
            snap: await loadLocalSnapshot(localGit(repo), repoIdFromRemote(info.remote, repo), branch, base),
            readBlob: localBlob(repo),
          }))} />
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
      {source === 'local' && <p className="hint">{t.localFetchHint}</p>}
      {error && <p data-testid="error" role="alert" className="flash err">{error}</p>}
      {loaded && (
        <ReviewView key={loaded.id} snap={loaded.snap} merged={loaded.merged} secret={device ? DEVICE_SECRET : settings.secret} store={loaded.store} readBlob={loaded.readBlob} />
      )}
    </main>
  );
}
