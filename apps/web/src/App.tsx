import { useEffect, useRef, useState } from 'react';
import { GitHub, GitHubError, loadSnapshot, loadAll, mergeStates, type DeviceState, type Snapshot } from '@viewed/core';
import { loadSettings, type Settings as S } from './settings';
import { Settings } from './components/Settings';
import { ReviewView } from './components/ReviewView';
import { getSyncStore, type SyncStore } from './syncStore';

export function App() {
  const [settings, setSettings] = useState<S | null | undefined>(undefined);
  const [form, setForm] = useState({ account: '', repo: '', branch: '', base: '' });
  const [loaded, setLoaded] = useState<{ id: number; snap: Snapshot; merged: DeviceState; store: SyncStore } | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    loadSettings().then(setSettings).catch(() => { setLoadError("Stored settings couldn't be read. Please enter them again."); setSettings(null); });
  }, []);
  if (settings === undefined) return null;
  // 토큰·비밀이 비어 있으면(첫 실행 또는 keychain 복호화 실패) 설정으로 보낸다 — spec §7 재입력
  const incomplete = !settings || !settings.secret || settings.accounts.length === 0
    || settings.accounts.some((a) => !a.token) || !settings.accounts.some((a) => a.label === settings.gistAccount);
  if (incomplete || editing) return <Settings initial={settings} notice={loadError} onSaved={(s) => {
    // gist 나 기기가 바뀌면 옛 저장소에 묶인 화면은 버린다 — 다시 열면 새 저장소를 쓴다
    if (settings && (s.gistId !== settings.gistId || s.deviceId !== settings.deviceId)) { seq.current++; setLoaded(null); }
    setSettings(s); setEditing(false);
  }} />;

  const token = (label: string) => settings.accounts.find((a) => a.label === label)?.token ?? '';
  async function open() {
    const mine = ++seq.current;
    setError(''); setLoaded(null);
    const repoStr = form.repo.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoStr)) { setError('Repository must look like owner/repo.'); return; }
    if (!form.branch.trim()) { setError('Branch is required.'); return; }
    try {
      const [owner, repo] = repoStr.split('/');
      const gh = new GitHub(token(form.account || settings!.accounts[0].label));
      const snap = await loadSnapshot(gh, owner, repo, form.branch.trim(), form.base || undefined);
      const gistGh = new GitHub(token(settings!.gistAccount));
      const all = await loadAll(gistGh, settings!.gistId, settings!.deviceId);
      // 쓰기는 기기당 하나인 저장소가 한다 — 읽은 own 을 합치고, 화면에는 로컬 기록까지 얹는다
      const store = getSyncStore(gistGh, settings!.gistId, settings!.deviceId);
      store.absorb(all.own);
      const merged = mergeStates([all.merged, store.own()]);
      if (mine !== seq.current) return;
      setLoaded({ id: mine, snap, merged, store });
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof GitHubError ? `GitHub ${e.status}: ${e.message}` : String(e));
    }
  }
  return (
    <main>
      <form data-testid="open-form" onSubmit={(e) => { e.preventDefault(); open(); }}>
        <select data-testid="account-select" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })}>
          {settings.accounts.map((a) => <option key={a.label}>{a.label}</option>)}</select>
        <input data-testid="repo-input" placeholder="owner/repo" value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} />
        <input data-testid="branch-input" placeholder="branch" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
        <input data-testid="base-input" placeholder="base (default branch)" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} />
        <button data-testid="open-btn">open</button>
        <button type="button" data-testid="settings-open" onClick={() => setEditing(true)}>settings</button>
      </form>
      {error && <p data-testid="error" role="alert">{error}</p>}
      {loaded && (
        <ReviewView key={loaded.id} snap={loaded.snap} merged={loaded.merged} secret={settings.secret} store={loaded.store} />
      )}
    </main>
  );
}
