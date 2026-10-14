import { useState } from 'react';
import { saveSettings, type Settings as S } from '../settings';

export function Settings({ initial, onSaved }: { initial: S | null; onSaved: (s: S) => void }) {
  const [s, setS] = useState<S>(initial ?? { accounts: [{ label: 'personal', token: '' }], gistAccount: 'personal', gistId: '', secret: '', deviceId: crypto.randomUUID().slice(0, 8) });
  const setAcc = (i: number, k: 'label' | 'token', v: string) => setS({ ...s, accounts: s.accounts.map((a, j) => (j === i ? { ...a, [k]: v } : a)) });
  return (
    <form data-testid="settings-form" onSubmit={async (e) => { e.preventDefault(); await saveSettings(s); onSaved(s); }}>
      {s.accounts.map((a, i) => (
        <fieldset key={i}>
          <input aria-label="account label" value={a.label} onChange={(e) => setAcc(i, 'label', e.target.value)} />
          <input aria-label="token" type="password" value={a.token} onChange={(e) => setAcc(i, 'token', e.target.value)} />
          <button type="button" onClick={() => setS({ ...s, accounts: s.accounts.filter((_, j) => j !== i) })}>remove</button>
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
