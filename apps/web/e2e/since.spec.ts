import { test, expect, type Page } from '@playwright/test';
import { MB1, MB2, mockGitHub, seedSettings, viewedGist } from './fixtures';

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

  // 방향키 탭 패턴을 구현하지 않으므로 tab 역할 대신 눌림 상태로 알린다
  await expect(row.getByRole('tab')).toHaveCount(0);
  await expect(row.getByTestId('since-tab')).toHaveAttribute('aria-pressed', 'true');
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

test('same blob but a different base diff shows a notice and the full diff, no empty since-diff', async ({ page }) => {
  await seedSettings(page);
  const old = { path: 'a.ts', status: 'modified' as const, blobSha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' };
  await mockGitHub(page, {
    head: 'h2',
    files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1,2 +1,2 @@\n-q\n+y\n+BASECHANGE' }],
    blobs: { a1: 'y\n' },
    gistFiles: await seedViewedRecord(old),
  });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row.getByTestId('since-same-content')).toBeVisible();
  await expect(row.getByTestId('diff')).toContainText('+BASECHANGE');
  await expect(row.getByTestId('since-diff')).toHaveCount(0);
});

test('a blob request that fails with 500 shows the error, not the force-push notice', async ({ page }) => {
  await seedSettings(page);
  const old = { path: 'a.ts', status: 'modified' as const, blobSha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' };
  await mockGitHub(page, {
    head: 'h2',
    files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: '@@ -1 +1,2 @@\n-x\n+y\n+NEWLINE' }],
    blobs: { a1: 'y\n' },
    gistFiles: await seedViewedRecord(old),
  });
  await page.route('**/git/blobs/a2', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }));
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row.getByTestId('since-error')).toBeVisible();
  await expect(row.getByTestId('since-unavailable')).toHaveCount(0);
});

const L = (lines: string[]) => lines.join('\n');
const P1 = L(['@@ -5,7 +5,7 @@', ' line 5', ' line 6', ' line 7', '-line 8', '+line 8 FEAT', ' line 9', ' line 10', ' line 11']);
const P1_REBASED = L(['@@ -5,7 +5,7 @@', ' line 5', ' line 6 DEV', ' line 7', '-line 8', '+line 8 FEAT', ' line 9', ' line 10', ' line 11']);
const P3 = L(['@@ -5,8 +5,8 @@', ' line 6 DEV', ' line 7', '-line 8', '+line 8 FEAT', ' line 9', ' line 10', '-line 11', '+line 11 FEAT2', ' line 12']);
const recordAt = (patch: string, base: string) =>
  viewedGist([{ filename: 'a.ts', status: 'modified', sha: 'a1', patch }], undefined, { base });

test('after a rebase, a file whose own blocks did not change stays viewed', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { head: 'h2', mergeBase: MB2, files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: P1_REBASED }], gistFiles: await recordAt(P1, MB1) });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row).toHaveAttribute('data-state', 'viewed');
  await expect(row.getByTestId('file-state')).toHaveText('Reviewed changes unchanged');
});

test('after a rebase, a file that lost one of its viewed blocks stays viewed with a warning badge', async ({ page }) => {
  // S2 — 확인한 블록 2개 중 1개가 base 에 들어갔거나 유실됨. 서명으로는 못 가르므로 확인함 + 경고
  const TWO = L(['@@ -1,3 +1,3 @@', ' l1', '-l2', '+l2 A', ' l3', '@@ -9,3 +9,3 @@', ' l9', '-l10', '+l10 B', ' l11']);
  const ONE = L(['@@ -9,3 +9,3 @@', ' l9', '-l10', '+l10 B', ' l11']);
  await seedSettings(page);
  await mockGitHub(page, { head: 'h2', mergeBase: MB2, files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: ONE }], gistFiles: await recordAt(TWO, MB1) });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row.getByTestId('file-state')).toHaveText('1 reviewed change dropped');
  await expect(row).toHaveAttribute('data-state', 'viewed');
  await expect(row.getByTestId('file-state')).not.toHaveClass(/muted/);   // 중립이 아닌 경고색
});

test('after a merge, only the hunk with my new block is shown and no blob is fetched', async ({ page }) => {
  await seedSettings(page);
  const blobRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/git/blobs/')) blobRequests.push(r.url()); });
  await mockGitHub(page, { head: 'h2', mergeBase: MB2, files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: P3 }], gistFiles: await recordAt(P1, MB1) });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row.getByTestId('since-blocks')).toBeVisible();
  await expect(row.getByTestId('since-diff')).toContainText('+line 11 FEAT2');
  for (const line of await row.getByTestId('since-diff').locator('.ln.add, .ln.del').allTextContents()) expect(line).not.toContain('DEV');
  expect(blobRequests).toEqual([]);
});

test('base unchanged keeps the line-level since diff from blobs', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, {
    head: 'h2', mergeBase: MB1,
    files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: '@@ -1 +1,2 @@\n-x\n+y\n+NEWLINE' }],
    blobs: { a1: 'y\n', a2: 'y\nNEWLINE\n' },
    gistFiles: await recordAt('@@ -1 +1 @@\n-x\n+y', MB1),
  });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row.getByTestId('since-diff')).toContainText('+NEWLINE');
  await expect(row.getByTestId('since-blocks')).toHaveCount(0);   // 화면이 그려진 뒤에 센다 — 그리기 전 0개로 통과하지 않게
  await expect(row.getByTestId('since-diff')).not.toContainText('-x');
});
