import { test, expect, type Page } from '@playwright/test';
import { mockGitHub, seedSettings, viewedGist } from './fixtures';

const files = [
  { filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' },
  { filename: 'logo.png', status: 'added', sha: 'p1' },   // patch 없음
];

async function open(page: Page) {
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
}

test('checking a file raises progress, collapses its diff and syncs only this device file', async ({ page }) => {
  await seedSettings(page);
  const { gistPatches } = await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  await expect(row.getByTestId('diff')).toBeVisible();
  await row.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await expect(row.getByTestId('diff')).toBeHidden();
  await expect.poll(() => gistPatches.length, { timeout: 5000 }).toBe(1);
  const body = gistPatches[0] as { files: Record<string, { content: string }> };
  expect(Object.keys(body.files)).toEqual(['device-mac.json']);
  expect(body.files['device-mac.json'].content).not.toContain('a.ts');   // 이름 원문이 안 나간다
  expect(body.files['device-mac.json'].content).toContain('"viewed":true');
});

test('a file without a patch can be checked but shows no body', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'logo.png' });
  await expect(row.getByTestId('no-patch')).toBeVisible();
  await row.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
});

test('a fully viewed but 300-file list shows the banner and never says complete', async ({ page }) => {
  await seedSettings(page);
  const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified', sha: `s${i}`, patch: 'p' }));
  await mockGitHub(page, { files: many, gistFiles: await viewedGist(many) });
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('300 / 300');   // 전부 봤는데도
  await expect(page.getByTestId('banner-incomplete')).toBeVisible();
  await expect(page.getByTestId('complete')).toHaveCount(0);
});

test('the complete message shows for a fully viewed, saved list', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files, gistFiles: await viewedGist(files) });
  await open(page);
  await expect(page.getByTestId('complete')).toBeVisible();
});

test('a failed gist write shows sync error and hides complete', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await page.route('https://api.github.com/gists/g1', (r) =>
    r.request().method() === 'PATCH' ? r.fulfill({ status: 500, body: '{}' }) : r.fallback());
  await open(page);
  await expect(page.getByTestId('file-row')).toHaveCount(2);   // .all() 은 기다리지 않는다 — 먼저 목록이 뜨길 기다린다
  for (const row of await page.getByTestId('file-row').all()) await row.getByTestId('file-check').check();
  await expect(page.getByTestId('sync-status')).toHaveText('sync failed', { timeout: 5000 });
  await expect(page.getByTestId('progress')).toHaveText('2 / 2');
  await expect(page.getByTestId('complete')).toHaveCount(0);
});

test('a check that failed to save survives a reload and is sent again', async ({ page }) => {
  await seedSettings(page);
  let fail = true;
  const { gistPatches } = await mockGitHub(page, { files });
  await page.route('https://api.github.com/gists/g1', (r) =>
    r.request().method() === 'PATCH' && fail ? r.fulfill({ status: 500, body: '{}' }) : r.fallback());
  await open(page);
  await page.getByTestId('file-row').first().getByTestId('file-check').check();
  await expect(page.getByTestId('sync-status')).toHaveText('sync failed', { timeout: 5000 });
  fail = false;
  await page.reload();
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await expect.poll(() => gistPatches.length, { timeout: 5000 }).toBe(1);
});

test('a slow first save cannot overwrite a later one', async ({ page }) => {
  await seedSettings(page);
  const { gistPatches } = await mockGitHub(page, { files });
  let first = true;
  await page.route('https://api.github.com/gists/g1', async (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback();
    if (first) { first = false; await new Promise((res) => setTimeout(res, 2500)); }
    return r.fallback();
  });
  await open(page);
  const rows = page.getByTestId('file-row');
  await rows.nth(0).getByTestId('file-check').check();
  await page.waitForTimeout(1700);   // 1.5초 디바운스가 첫 저장을 보냄 — 응답이 2.5초 늦다
  await rows.nth(1).getByTestId('file-check').check();
  await expect.poll(() => gistPatches.length, { timeout: 8000 }).toBe(2);
  const last = gistPatches[1] as { files: Record<string, { content: string }> };
  expect(Object.keys(JSON.parse(last.files['device-mac.json'].content))).toHaveLength(2);
});

test('a patch ending in a newline gets no phantom line, and each check is named by its file', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y\n' }] });
  await open(page);
  await expect(page.getByTestId('diff').locator('.ln')).toHaveCount(3);
  await expect(page.getByRole('checkbox', { name: 'Viewed a.ts' })).toBeVisible();
});

test('the filter hides viewed files and says so when nothing is left', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await page.getByTestId('filter-unviewed').check();
  await expect(page.getByTestId('file-row')).toHaveCount(1);
  await expect(page.getByTestId('file-row')).toContainText('logo.png');
  await page.getByTestId('file-row').getByTestId('file-check').click();   // 체크하면 바로 목록에서 빠진다
  await expect(page.getByTestId('file-row')).toHaveCount(0);
  await expect(page.getByTestId('filter-empty')).toBeVisible();
  await page.getByTestId('filter-unviewed').uncheck();
  await expect(page.getByTestId('file-row')).toHaveCount(2);
});

test('device-only storage keeps check marks across reloads and never calls the gist', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('viewed.settings', JSON.stringify({
    accounts: [{ label: 'personal', token: 'tok' }], gistAccount: 'personal', gistId: '', secret: 'k', deviceId: 'mac', storage: 'device' })));
  const { gistPatches } = await mockGitHub(page, { files });
  const gistCalls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/gists')) gistCalls.push(r.url()); });
  await open(page);
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await page.reload();
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  expect(gistCalls).toEqual([]);
  expect(gistPatches).toEqual([]);
});

test('switching storage to this device drops the open review, and later checks never reach the gist', async ({ page }) => {
  await seedSettings(page);
  const { gistPatches } = await mockGitHub(page, { files });
  await open(page);
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await page.getByTestId('settings-open').click();
  await page.getByTestId('storage-device').check();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('file-row')).toHaveCount(0);   // 옛 저장소에 묶인 화면은 버린다
  await page.getByTestId('open-btn').click();   // goto 하면 seedSettings 가 gist 설정을 다시 심는다 — 같은 페이지에서 다시 연다
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await page.waitForTimeout(2500);   // gist 저장 예약(1.5초)이 있었다면 지났다
  expect(gistPatches).toEqual([]);
});

test('device-only check marks do not depend on the shared secret', async ({ page }) => {
  const settings = (secret: string) => JSON.stringify({ accounts: [{ label: 'personal', token: 'tok' }], gistAccount: 'personal', gistId: '', secret, deviceId: 'mac', storage: 'device' });
  await page.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('viewed.settings', s); sessionStorage.setItem('seeded', '1'); } }, settings('first'));
  await mockGitHub(page, { files });
  await open(page);
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await page.evaluate((s) => localStorage.setItem('viewed.settings', s), settings('second'));   // gist 모드를 다녀오며 비밀이 바뀐 상황
  await page.reload();
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
});
