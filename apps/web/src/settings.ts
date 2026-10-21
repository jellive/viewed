import type { DesktopAsk } from './ask';

export interface AccountCfg { label: string; token: string }
// storage: 'gist' = 비밀 gist 로 기기 간 동기화(기본, 옛 설정 포함) / 'device' = 이 기기에만, 토큰 없이도 된다
export interface Settings { accounts: AccountCfg[]; gistAccount: string; gistId: string; secret: string; deviceId: string; storage?: 'gist' | 'device' }

declare global {
  interface DesktopGit {
    pick(): Promise<string | null>;
    list(): Promise<string[]>;
    info(repo: string): Promise<{ refs: string[]; defaultBase: string | null; current: string | null; remote: string | null }>;
    run(repo: string, op: 'resolve' | 'mergeBase' | 'rawDiff' | 'patchDiff' | 'blob', a: string, b?: string): Promise<string | null>;
  }
  interface Window { viewedDesktop?: { getSecret(name: string): Promise<string | null>; setSecret(name: string, value: string): Promise<void>; git?: DesktopGit; ask?: DesktopAsk } }
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
