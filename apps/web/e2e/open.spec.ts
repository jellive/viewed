import { test, expect } from '@playwright/test';
import { mockGitHub, seedSettings, viewedGist } from './fixtures';

test('first run shows settings', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('settings-form')).toBeVisible();
});

test('opens a branch and lists changed files with 0/N progress', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files: [
    { filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' },
    { filename: 'b.ts', status: 'added', sha: 'b1', patch: '@@ -0,0 +1 @@\n+z' },
  ] });
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
});

test('a missing token (e.g. keychain decrypt failed) sends you back to settings', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('viewed.settings', JSON.stringify({
    accounts: [{ label: 'personal', token: '' }], gistAccount: 'personal', gistId: 'g1', secret: 's3cret', deviceId: 'mac' })));
  await page.goto('/');
  await expect(page.getByTestId('settings-form')).toBeVisible();
  await expect(page.getByLabel('gist id')).toHaveValue('g1');   // 기존 값은 유지
});

test('settings can be reopened', async ({ page }) => {
  await seedSettings(page);
  await page.goto('/');
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-form')).toBeVisible();
});

test('a bad token shows an error, not an empty list', async ({ page }) => {
  await seedSettings(page);
  await page.route('https://api.github.com/**', (r) => r.fulfill({ status: 401, body: '{"message":"Bad credentials"}' }));
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('error')).toContainText('401');
});

test('a failing save (e.g. keychain write rejected) shows the error in settings', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).viewedDesktop = { getSecret: async () => null, setSecret: async () => { throw new Error('keychain write failed'); } };
  });
  await page.goto('/');
  await page.getByLabel('token').fill('tok');
  await page.getByLabel('gist id').fill('g1');
  await page.getByLabel('shared secret').fill('s3cret');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-error')).toContainText('keychain write failed');
});

test('a capitalised owner/repo still finds records written with the lowercase name', async ({ page }) => {
  await seedSettings(page);
  const files = [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' }];
  await mockGitHub(page, { files, gistFiles: await viewedGist(files) });
  // GitHub 은 owner/repo 대소문자를 구분하지 않는다 — 모의 경로도 소문자로 받는다
  await page.route(/api\.github\.com\/repos\/Acme\/Widget/i, (r) => {
    const u = r.request().url().replace(/\/repos\/Acme\/Widget/i, '/repos/acme/widget');
    return r.fallback({ url: u });
  });
  await page.goto('/');
  await page.getByTestId('repo-input').fill('Acme/Widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 1');
});

test('device id must be 1-32 of letters, digits, _ or -', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('token').fill('t');
  await page.getByLabel('gist id').fill('g1');
  await page.getByLabel('shared secret').fill('s');
  for (const bad of ['a/b', '']) {
    await page.getByLabel('device id').fill(bad);
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-error')).toContainText(/device id/i);
  }
});
