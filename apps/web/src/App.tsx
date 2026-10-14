import { useEffect, useState } from 'react';
import { GitHub, GitHubError, loadSnapshot, loadAll, buildReview, type Review, type Snapshot } from '@viewed/core';
import { loadSettings, type Settings as S } from './settings';
import { Settings } from './components/Settings';

export function App() {
  const [settings, setSettings] = useState<S | null | undefined>(undefined);
  const [form, setForm] = useState({ account: '', repo: '', branch: '', base: '' });
  const [loaded, setLoaded] = useState<{ snap: Snapshot; review: Review } | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => { loadSettings().then(setSettings); }, []);
  if (settings === undefined) return null;
  // 토큰·비밀이 비어 있으면(첫 실행 또는 keychain 복호화 실패) 설정으로 보낸다 — spec §7 재입력
  const incomplete = !settings || !settings.secret || settings.accounts.some((a) => !a.token);
  if (incomplete || editing) return <Settings initial={settings} onSaved={(s) => { setSettings(s); setEditing(false); }} />;

  const token = (label: string) => settings.accounts.find((a) => a.label === label)?.token ?? '';
  async function open() {
    setError(''); setLoaded(null);
    try {
      const [owner, repo] = form.repo.split('/');
      const gh = new GitHub(token(form.account || settings!.accounts[0].label));
      const snap = await loadSnapshot(gh, owner, repo, form.branch, form.base || undefined);
      const { merged } = await loadAll(new GitHub(token(settings!.gistAccount)), settings!.gistId, settings!.deviceId);
      setLoaded({ snap, review: await buildReview(snap, merged, settings!.secret) });
    } catch (e) {
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
        <section>
          <p data-testid="progress">{loaded.review.viewedCount} / {loaded.review.total}</p>
          <ul>{loaded.review.items.map((it) => <li key={it.key} data-testid="file-row">{it.file.path}</li>)}</ul>
        </section>
      )}
    </main>
  );
}
