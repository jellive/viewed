export interface AccountCfg { label: string; token: string }
export interface Settings { accounts: AccountCfg[]; gistAccount: string; gistId: string; secret: string; deviceId: string }

declare global {
  interface Window { viewedDesktop?: { getSecret(name: string): Promise<string | null>; setSecret(name: string, value: string): Promise<void> } }
}

const KEY = 'viewed.settings';

// Electron 이면 토큰·공유 비밀은 keychain(safeStorage) 쪽에 두고, localStorage 에는 빈 값만 남긴다
export async function loadSettings(): Promise<Settings | null> {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  const s = JSON.parse(raw) as Settings;
  const d = window.viewedDesktop;
  if (!d) return s;
  const accounts = await Promise.all(s.accounts.map(async (a) => ({ ...a, token: (await d.getSecret(`token:${a.label}`)) ?? '' })));
  return { ...s, accounts, secret: (await d.getSecret('secret')) ?? '' };
}

export async function saveSettings(s: Settings): Promise<void> {
  const d = window.viewedDesktop;
  if (!d) { localStorage.setItem(KEY, JSON.stringify(s)); return; }
  for (const a of s.accounts) await d.setSecret(`token:${a.label}`, a.token);
  await d.setSecret('secret', s.secret);
  localStorage.setItem(KEY, JSON.stringify({ ...s, secret: '', accounts: s.accounts.map((a) => ({ ...a, token: '' })) }));
}
