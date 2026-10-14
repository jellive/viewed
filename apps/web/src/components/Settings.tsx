import { useState } from 'react';
import { saveSettings, type Settings as S } from '../settings';

function validate(s: S): string {
  if (s.accounts.length === 0) return 'Add at least one account.';
  const labels = s.accounts.map((a) => a.label.trim());
  if (labels.some((l) => !l)) return 'Account labels must not be empty.';
  if (new Set(labels).size !== labels.length) return 'Account labels must be unique (duplicate label).';
  if (s.accounts.some((a) => !a.token)) return 'Every account needs a token.';
  if (!s.gistId.trim()) return 'Gist id is required.';
  if (!s.secret) return 'Shared secret is required.';
  return '';
}

export function Settings({ initial, onSaved, notice }: { initial: S | null; onSaved: (s: S) => void; notice?: string }) {
  const [s, setS] = useState<S>(initial ?? { accounts: [{ label: 'personal', token: '' }], gistAccount: 'personal', gistId: '', secret: '', deviceId: crypto.randomUUID().slice(0, 8) });
  const [err, setErr] = useState(notice ?? '');
  // gistAccount 는 label 로 가리키므로 label 이 바뀌면 따라가고, 지워지면 남은 첫 계정으로 옮긴다
  const setAcc = (i: number, k: 'label' | 'token', v: string) => setS({
    ...s,
    accounts: s.accounts.map((a, j) => (j === i ? { ...a, [k]: v } : a)),
    gistAccount: k === 'label' && s.accounts[i].label === s.gistAccount ? v : s.gistAccount,
  });
  const removeAcc = (i: number) => {
    const accounts = s.accounts.filter((_, j) => j !== i);
    const gone = s.accounts[i].label === s.gistAccount;
    setS({ ...s, accounts, gistAccount: gone ? (accounts[0]?.label ?? '') : s.gistAccount });
  };
  return (
    <form data-testid="settings-form" onSubmit={async (e) => {
      e.preventDefault();
      const problem = validate(s);
      if (problem) { setErr(problem); return; }
      setErr(''); await saveSettings(s); onSaved(s);
    }}>
      {err && <p data-testid="settings-error" role="alert">{err}</p>}
      {s.accounts.map((a, i) => (
        <fieldset key={i}>
          <input aria-label="account label" value={a.label} onChange={(e) => setAcc(i, 'label', e.target.value)} />
          <input aria-label="token" type="password" value={a.token} onChange={(e) => setAcc(i, 'token', e.target.value)} />
          <button type="button" onClick={() => removeAcc(i)}>remove</button>
        </fieldset>
      ))}
      <button type="button" onClick={() => setS({ ...s, accounts: [...s.accounts, { label: '', token: '' }] })}>add account</button>
      <label>gist account <select value={s.gistAccount} onChange={(e) => setS({ ...s, gistAccount: e.target.value })}>
        {s.accounts.map((a) => <option key={a.label}>{a.label}</option>)}</select></label>
      <input aria-label="gist id" value={s.gistId} onChange={(e) => setS({ ...s, gistId: e.target.value })} />
      <input aria-label="shared secret" type="password" value={s.secret} onChange={(e) => setS({ ...s, secret: e.target.value })} />
      <input aria-label="device id" value={s.deviceId} onChange={(e) => setS({ ...s, deviceId: e.target.value })} />
      <button data-testid="settings-save">save</button>
    </form>
  );
}
