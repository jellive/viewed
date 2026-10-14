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
