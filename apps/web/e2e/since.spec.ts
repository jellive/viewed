import { test, expect, type Page } from '@playwright/test';
import { mockGitHub, seedSettings, viewedGist } from './fixtures';

const seedViewedRecord = (f: { path: string; status: 'modified' | 'added'; blobSha: string; patch?: string }) =>
  viewedGist([{ filename: f.path, status: f.status, sha: f.blobSha, ...(f.patch !== undefined ? { patch: f.patch } : {}) }]);

async function open(page: Page) {
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
}

test('a viewed file stays viewed when nothing changed', async ({ page }) => {
  await seedSettings(page);
  const old = { path: 'a.ts', status: 'modified' as const, blobSha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' };
  await mockGitHub(page, { files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: old.patch }], gistFiles: await seedViewedRecord(old) });
  await open(page);
  await expect(page.getByTestId('file-row')).toHaveAttribute('data-state', 'viewed');
});

test('after a new push only the changed lines since viewing are shown', async ({ page }) => {
  await seedSettings(page);
  const old = { path: 'a.ts', status: 'modified' as const, blobSha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' };
  await mockGitHub(page, {
    head: 'h2',
    files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: '@@ -1 +1,2 @@\n-x\n+y\n+NEWLINE' }],
    blobs: { a1: 'y\n', a2: 'y\nNEWLINE\n' },
    gistFiles: await seedViewedRecord(old),
  });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row.getByTestId('since-diff')).toContainText('+NEWLINE');
  await expect(row.getByTestId('since-diff')).not.toContainText('-x');   // base 대비 변경은 안 보인다
});

test('a force-pushed-away blob falls back to the full diff with a notice', async ({ page }) => {
  await seedSettings(page);
  const old = { path: 'a.ts', status: 'modified' as const, blobSha: 'gone', patch: '@@ -1 +1 @@\n-x\n+old' };
  await mockGitHub(page, {
    head: 'h2',
    files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: '@@ -1 +1 @@\n-x\n+new' }],
    blobs: { a2: 'new\n' },
    gistFiles: await seedViewedRecord(old),
  });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row.getByTestId('since-unavailable')).toBeVisible();
  await expect(row.getByTestId('diff')).toContainText('+new');
});

test('a changed binary file stays body-less and never fetches blobs', async ({ page }) => {
  await seedSettings(page);
  const blobRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/git/blobs/')) blobRequests.push(r.url()); });
  await mockGitHub(page, {
    head: 'h2',
    files: [{ filename: 'logo.png', status: 'added', sha: 'p2' }],
    gistFiles: await seedViewedRecord({ path: 'logo.png', status: 'added', blobSha: 'p1' }),
  });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row.getByTestId('no-patch')).toBeVisible();
  expect(blobRequests).toEqual([]);
});
