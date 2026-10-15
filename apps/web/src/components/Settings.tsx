import { cloneElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { saveSettings, type Settings as S } from '../settings';

function validate(s: S): string {
  if (s.accounts.length === 0) return 'Add at least one account.';
  const labels = s.accounts.map((a) => a.label.trim());
  if (labels.some((l) => !l)) return 'Account labels must not be empty.';
  if (new Set(labels).size !== labels.length) return 'Account labels must be unique (duplicate label).';
  if (s.accounts.some((a) => !a.token)) return 'Every account needs a token.';
  if (!s.gistId.trim()) return 'Gist id is required.';
  if (!s.secret) return 'Shared secret is required.';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(s.deviceId)) return 'Device id must be 1-32 letters, digits, _ or -.';
  return '';
}

// 도움말은 label 밖에 둔다 — label 텍스트에 섞이면 getByLabel 이 엉뚱한 칸까지 잡는다. 칸과는 aria-describedby 로 잇는다
function Field({ name, hint, children }: { name: string; hint: ReactNode; children: ReactElement<{ 'aria-describedby'?: string }> }) {
  const id = useId();
  return (
    <div className="field">
      <label><span>{name}</span>{cloneElement(children, { 'aria-describedby': id })}</label>
      <small id={id}>{hint}</small>
    </div>
  );
}

const ext = { target: '_blank', rel: 'noreferrer' } as const;

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
    <form data-testid="settings-form" className="settings" onSubmit={async (e) => {
      e.preventDefault();
      const problem = validate(s);
      if (problem) { setErr(problem); return; }
      setErr('');
      try { await saveSettings(s); } catch (x) { setErr(`Could not save settings: ${x instanceof Error ? x.message : String(x)}`); return; }
      onSaved(s);
    }}>
      <h1>Settings</h1>
      {err && <p data-testid="settings-error" role="alert" className="flash err">{err}</p>}
      {s.accounts.map((a, i) => (
        <fieldset key={i} className="account">
          <Field name="Account name" hint="Any name, like personal or work. Add another account for repositories that need a different token.">
            <input aria-label="account label" value={a.label} onChange={(e) => setAcc(i, 'label', e.target.value)} />
          </Field>
          <Field name="GitHub token" hint={<>Fine-grained token with read access to Contents and Metadata on the repositories you review. The token of the account that owns the gist also needs Gists read and write. <a href="https://github.com/settings/personal-access-tokens/new" {...ext}>Create a token</a></>}>
            <input aria-label="token" type="password" value={a.token} onChange={(e) => setAcc(i, 'token', e.target.value)} />
          </Field>
          <button type="button" onClick={() => removeAcc(i)}>remove</button>
        </fieldset>
      ))}
      <button type="button" onClick={() => setS({ ...s, accounts: [...s.accounts, { label: '', token: '' }] })}>add account</button>
      <p className="lead">Your check marks are saved to a secret gist, so every device sees the same files as viewed. Code never goes there — only hashed file names and diff fingerprints.</p>
      <Field name="Account that owns the gist" hint="Its token reads and writes your check marks.">
        <select value={s.gistAccount} onChange={(e) => setS({ ...s, gistAccount: e.target.value })}>
          {s.accounts.map((a) => <option key={a.label}>{a.label}</option>)}</select>
      </Field>
      <Field name="Gist id" hint={<>Create a secret gist with any one file at <a href="https://gist.github.com/" {...ext}>gist.github.com</a>, then paste the id from its address: gist.github.com/you/<b>id</b>. Use the same gist on every device.</>}>
        <input aria-label="gist id" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={s.gistId} onChange={(e) => setS({ ...s, gistId: e.target.value })} />
      </Field>
      <Field name="Shared secret" hint="A passphrase you choose. File names are stored as hashes made with it. Use the same one on every device.">
        <input aria-label="shared secret" type="password" value={s.secret} onChange={(e) => setS({ ...s, secret: e.target.value })} />
      </Field>
      <Field name="Device id" hint="Made for this device. Leave it as it is, and don't copy it from another device.">
        <input aria-label="device id" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={s.deviceId} onChange={(e) => setS({ ...s, deviceId: e.target.value })} />
      </Field>
      <button data-testid="settings-save" className="primary">save</button>
    </form>
  );
}
