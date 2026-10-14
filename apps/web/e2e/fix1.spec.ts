import { test, expect } from '@playwright/test';
import { mockGitHub, seedSettings, SETTINGS } from './fixtures';

const FILES = [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' }];

async function openBranch(page: import('@playwright/test').Page, repo = 'acme/widget', branch = 'feat') {
  await page.getByTestId('repo-input').fill(repo);
  await page.getByTestId('branch-input').fill(branch);
  await page.getByTestId('open-btn').click();
}

test('F2: with a desktop bridge, token and secret never reach localStorage and are restored from it', async ({ page }) => {
  await page.addInitScript(() => {
    const store: Record<string, string> = JSON.parse(sessionStorage.getItem('stub') ?? '{}');
    (window as any).viewedDesktop = {
      getSecret: async (n: string) => store[n] ?? null,
      setSecret: async (n: string, v: string) => { store[n] = v; sessionStorage.setItem('stub', JSON.stringify(store)); },
    };
  });
  await page.goto('/');
  await page.getByLabel('token').fill('TOKEN-xyz');
  await page.getByLabel('gist id').fill('g1');
  await page.getByLabel('shared secret').fill('SECRET-abc');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('open-form')).toBeVisible();
  const raw = await page.evaluate(() => localStorage.getItem('viewed.settings'));
  expect(raw).not.toBeNull();
  expect(raw).not.toContain('TOKEN-xyz');
  expect(raw).not.toContain('SECRET-abc');
  await page.reload();
  await expect(page.getByTestId('open-form')).toBeVisible();   // restored from the stub
});

test('F3: renaming the gist account follows the rename (gist request keeps its bearer)', async ({ page }) => {
  await seedSettings(page);
  const auth: (string | undefined)[] = [];
  await mockGitHub(page, { files: FILES });
  await page.route('https://api.github.com/gists/**', (r) => { auth.push(r.request().headers()['authorization']); r.fallback(); });
  await page.goto('/');
  await page.getByTestId('settings-open').click();
  await page.getByLabel('account label').fill('work');
  await page.getByTestId('settings-save').click();
  await openBranch(page);
  await expect(page.getByTestId('progress')).toHaveText('0 / 1');
  expect(auth.length).toBeGreaterThan(0);
  for (const a of auth) expect(a).toBe('Bearer tok');
});

test('F3: a gistAccount that matches no label is treated as incomplete', async ({ page }) => {
  await page.addInitScript((s) => localStorage.setItem('viewed.settings', JSON.stringify({ ...s, gistAccount: 'ghost' })), SETTINGS);
  await page.goto('/');
  await expect(page.getByTestId('settings-form')).toBeVisible();
});

test('F4: duplicate labels are rejected and nothing is saved', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('token').fill('t1');
  await page.getByRole('button', { name: 'add account' }).click();
  await page.getByLabel('account label').nth(1).fill('personal');
  await page.getByLabel('token').nth(1).fill('t2');
  await page.getByLabel('gist id').fill('g1');
  await page.getByLabel('shared secret').fill('s');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-error')).toContainText(/unique|duplicate/i);
  expect(await page.evaluate(() => localStorage.getItem('viewed.settings'))).toBeNull();
});

test('F4: an empty token is rejected with a message', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('gist id').fill('g1');
  await page.getByLabel('shared secret').fill('s');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-error')).toContainText(/token/i);
  expect(await page.evaluate(() => localStorage.getItem('viewed.settings'))).toBeNull();
});

test('F5: zero accounts shows settings without crashing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((s) => localStorage.setItem('viewed.settings', JSON.stringify({ ...s, accounts: [] })), SETTINGS);
  await page.goto('/');
  await expect(page.getByTestId('settings-form')).toBeVisible();
  expect(errors).toEqual([]);
});

test('F6: corrupt stored settings fall back to the settings form with a message', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('viewed.settings', '{not json'));
  await page.goto('/');
  await expect(page.getByTestId('settings-form')).toBeVisible();
  await expect(page.getByTestId('settings-error')).toContainText(/read/i);
});

test('F7: malformed repo or empty branch shows an error and makes no request', async ({ page }) => {
  await seedSettings(page);
  let calls = 0;
  await page.route('https://api.github.com/**', (r) => { calls++; r.fulfill({ status: 500, body: '{}' }); });
  await page.goto('/');
  await openBranch(page, 'widget', 'feat');
  await expect(page.getByTestId('error')).toBeVisible();
  await openBranch(page, 'acme/widget/extra', 'feat');
  await expect(page.getByTestId('error')).toBeVisible();
  await openBranch(page, 'acme/widget', '');
  await expect(page.getByTestId('error')).toBeVisible();
  expect(calls).toBe(0);
});

test('F8: a late response from an earlier open does not overwrite the latest', async ({ page }) => {
  await seedSettings(page);
  await page.route('https://api.github.com/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const m = p.match(/^\/repos\/acme\/widget\/branches\/(slow|fast)$/);
    if (p === '/repos/acme/widget') return json({ default_branch: 'main' });
    if (m) { if (m[1] === 'slow') await new Promise((r) => setTimeout(r, 2000)); return json({ commit: { sha: m[1] } }); }
    const c = p.match(/^\/repos\/acme\/widget\/compare\/main\.\.\.(slow|fast)$/);
    if (c) return json({ files: c[1] === 'slow' ? [{ filename: 's1.ts', status: 'added', sha: 's1', patch: '@@ -0,0 +1 @@\n+a' }, { filename: 's2.ts', status: 'added', sha: 's2', patch: '@@ -0,0 +1 @@\n+b' }] : [{ filename: 'f1.ts', status: 'added', sha: 'f1', patch: '@@ -0,0 +1 @@\n+a' }] });
    const t = p.match(/^\/repos\/acme\/widget\/git\/trees\/(slow|fast)$/);
    if (t) return json({ truncated: false, tree: (t[1] === 'slow' ? ['s1.ts', 's2.ts'] : ['f1.ts']).map((path) => ({ path, type: 'blob', mode: '100644' })) });
    if (p === '/gists/g1') return json({ files: {} });
    return route.fulfill({ status: 500, body: '{}' });
  });
  await page.goto('/');
  await openBranch(page, 'acme/widget', 'slow');
  await openBranch(page, 'acme/widget', 'fast');
  await expect(page.getByTestId('progress')).toHaveText('0 / 1');
  await page.waitForTimeout(2600);
  await expect(page.getByTestId('progress')).toHaveText('0 / 1');
  await expect(page.getByTestId('file-row')).toHaveCount(1);
  await expect(page.getByTestId('file-row')).toContainText('f1.ts');   // 행에 상태 표시·diff 가 같이 있다
});
