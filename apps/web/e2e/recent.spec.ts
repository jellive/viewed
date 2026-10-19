import { test, expect } from '@playwright/test';
import { mockGitHub, seedSettings, SETTINGS } from './fixtures';

const files = [
  { filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' },
  { filename: 'logo.png', status: 'added', sha: 'p1' },
];

// GitHub 모드는 칸만 채운다 — 폰에서 토큰이 만료됐으면 켜자마자 오류가 나므로 자동으로 열지 않는다
test('the GitHub fields come back as last opened, and nothing opens by itself', async ({ page }) => {
  await page.addInitScript((s) => localStorage.setItem('viewed.settings', JSON.stringify(s)),
    { ...SETTINGS, accounts: [{ label: 'personal', token: 'tok' }, { label: 'work', token: 'tok2' }] });
  await mockGitHub(page, { files });
  const compares: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/compare/')) compares.push(r.url()); });
  await page.goto('/');
  await page.getByTestId('account-select').selectOption('work');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await page.getByTestId('branch-input').fill('other');   // 열지 않은 입력은 기억하지 않는다
  await page.reload();
  await expect(page.getByTestId('account-select')).toHaveValue('work');
  await expect(page.getByTestId('repo-input')).toHaveValue('acme/widget');
  await expect(page.getByTestId('branch-input')).toHaveValue('feat');
  await expect(page.getByTestId('base-input')).toHaveValue('');   // 빈 base 는 빈 채로 — 매번 기본 브랜치
  await page.waitForTimeout(500);
  await expect(page.getByTestId('file-row')).toHaveCount(0);
  expect(compares).toHaveLength(1);
});

test('a remembered GitHub account that is gone opens with the first account', async ({ page }) => {
  await seedSettings(page);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify(
    { last: { source: 'github', account: 'ghost', repo: 'acme/widget', branch: 'feat', base: '' }, local: {} })));
  await mockGitHub(page, { files });
  const auth: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/compare/')) auth.push(r.headers()['authorization'] ?? ''); });
  await page.goto('/');
  await expect(page.getByTestId('repo-input')).toHaveValue('acme/widget');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  expect(auth).toEqual(['Bearer tok']);
});

test('on the desktop the source last opened comes back', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [{ label: 'personal', token: '' }], gistAccount: 'personal', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    (window as any).viewedDesktop = {
      getSecret: async (n: string) => (n === 'token:personal' ? 'tok' : null),
      setSecret: async () => {},
      git: { pick: async () => null, list: async () => [], info: async () => { throw new Error('none'); }, run: async () => null },
    };
  });
  await mockGitHub(page, { files });
  await page.goto('/');
  await expect(page.getByTestId('source-local')).toHaveAttribute('aria-pressed', 'true');   // 기록이 없으면 로컬 폴더
  await page.getByTestId('source-github').click();
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await page.reload();
  await expect(page.getByTestId('source-github')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('repo-input')).toHaveValue('acme/widget');
});
