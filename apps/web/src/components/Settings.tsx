import { cloneElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { saveSettings, type Settings as S } from '../settings';
import { t } from '../i18n';

function validate(s: S): string {
  if (s.accounts.length === 0) return t.needAccount;
  const labels = s.accounts.map((a) => a.label.trim());
  if (labels.some((l) => !l)) return t.emptyLabel;
  if (new Set(labels).size !== labels.length) return t.duplicateLabel;
  if (s.accounts.some((a) => !a.token)) return t.needToken;
  if (!s.gistId.trim()) return t.needGist;
  if (!s.secret) return t.needSecret;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(s.deviceId)) return t.badDeviceId;
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
      try { await saveSettings(s); } catch (x) { setErr(t.saveFailed(x instanceof Error ? x.message : String(x))); return; }
      onSaved(s);
    }}>
      <h1>{t.settingsTitle}</h1>
      {err && <p data-testid="settings-error" role="alert" className="flash err">{err}</p>}
      {s.accounts.map((a, i) => (
        <fieldset key={i} className="account">
          <Field name={t.accountName} hint={t.accountNameHint}>
            <input aria-label={t.aria.accountLabel} value={a.label} onChange={(e) => setAcc(i, 'label', e.target.value)} />
          </Field>
          <Field name={t.token} hint={<>{t.tokenHint} <a href="https://github.com/settings/personal-access-tokens/new" {...ext}>{t.createToken}</a></>}>
            <input aria-label={t.aria.token} type="password" value={a.token} onChange={(e) => setAcc(i, 'token', e.target.value)} />
          </Field>
          <button type="button" onClick={() => removeAcc(i)}>{t.remove}</button>
        </fieldset>
      ))}
      <button type="button" onClick={() => setS({ ...s, accounts: [...s.accounts, { label: '', token: '' }] })}>{t.addAccount}</button>
      <p className="lead">{t.lead}</p>
      <Field name={t.gistAccount} hint={t.gistAccountHint}>
        <select value={s.gistAccount} onChange={(e) => setS({ ...s, gistAccount: e.target.value })}>
          {s.accounts.map((a) => <option key={a.label}>{a.label}</option>)}</select>
      </Field>
      <Field name={t.gistId} hint={<>{t.gistIdHintBefore && `${t.gistIdHintBefore} `}<a href="https://gist.github.com/" {...ext}>gist.github.com</a>{t.gistIdHintAfter}<b>id</b>{t.gistIdHintEnd}</>}>
        <input aria-label={t.aria.gistId} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={s.gistId} onChange={(e) => setS({ ...s, gistId: e.target.value })} />
      </Field>
      <Field name={t.secret} hint={t.secretHint}>
        <input aria-label={t.aria.secret} type="password" value={s.secret} onChange={(e) => setS({ ...s, secret: e.target.value })} />
      </Field>
      <Field name={t.deviceId} hint={t.deviceIdHint}>
        <input aria-label={t.aria.deviceId} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={s.deviceId} onChange={(e) => setS({ ...s, deviceId: e.target.value })} />
      </Field>
      <button data-testid="settings-save" className="primary">{t.save}</button>
    </form>
  );
}
