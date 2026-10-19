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
// 확인한 블록(line 8)과 새 블록(line 20)이 서로 다른 덩어리에 있다 — 덩어리 선별이 실제로 일하는지 재려고
const P3_APART = L([
  '@@ -5,7 +5,7 @@', ' line 5', ' line 6 DEV', ' line 7', '-line 8', '+line 8 FEAT', ' line 9', ' line 10', ' line 11',
  '@@ -17,7 +17,7 @@', ' line 17', ' line 18', ' line 19', '-line 20', '+line 20 FEAT2', ' line 21', ' line 22', ' line 23',
]);
// 확인한 블록 2개(TWO) 중 1개만 남음(ONE)
const TWO = L(['@@ -1,3 +1,3 @@', ' l1', '-l2', '+l2 A', ' l3', '@@ -9,3 +9,3 @@', ' l9', '-l10', '+l10 B', ' l11']);
const ONE = L(['@@ -9,3 +9,3 @@', ' l9', '-l10', '+l10 B', ' l11']);
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
  await seedSettings(page);
  await mockGitHub(page, { head: 'h2', mergeBase: MB2, files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: ONE }], gistFiles: await recordAt(TWO, MB1) });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row.getByTestId('file-state')).toHaveText('1 reviewed change dropped');
  await expect(row).toHaveAttribute('data-state', 'viewed');
  await expect(row.getByTestId('file-state')).not.toHaveClass(/muted/);   // 중립이 아닌 경고색
});

// 확인한 블록이 빠진 파일은 확인함이지만 경고가 붙은 것이라 '확인한 파일 숨기기'에도 남는다. 확인한 블록이 그대로인 파일은 숨는다
test('the hide-viewed filter keeps a file that lost viewed blocks and hides one whose blocks are unchanged', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, {
    head: 'h2', mergeBase: MB2,
    files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: ONE }, { filename: 'b.ts', status: 'modified', sha: 'b2', patch: P1_REBASED }],
    gistFiles: await viewedGist([{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: TWO }, { filename: 'b.ts', status: 'modified', sha: 'b1', patch: P1 }], undefined, { base: MB1 }),
  });
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('2 / 2');
  await expect(page.getByTestId('file-row').filter({ hasText: 'b.ts' }).getByTestId('file-state')).toHaveText('Reviewed changes unchanged');
  await page.getByTestId('filter-unviewed').check();
  const rows = page.getByTestId('file-row');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('a.ts');
  await expect(rows).toHaveAttribute('data-state', 'viewed');
  await expect(rows.getByTestId('file-state')).toHaveText('1 reviewed change dropped');
  await expect(page.getByTestId('filter-empty')).toHaveCount(0);   // 남은 행이 있으니 '남은 게 없다' 문구는 없다
  await expect(page.getByTestId('progress')).toHaveText('2 / 2');   // 진행률은 그대로 — 상태는 확인함
});

test('after a merge, only the hunk with my new block is shown and no blob is fetched', async ({ page }) => {
  await seedSettings(page);
  const blobRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/git/blobs/')) blobRequests.push(r.url()); });
  await mockGitHub(page, { head: 'h2', mergeBase: MB2, files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: P3_APART }], gistFiles: await recordAt(P1, MB1) });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row.getByTestId('since-blocks')).toBeVisible();
  await expect(row.getByTestId('since-diff')).toContainText('+line 20 FEAT2');
  await expect(row.getByTestId('since-diff')).not.toContainText('line 8 FEAT');   // 확인한 블록만 든 덩어리는 빠진다
  for (const line of await row.getByTestId('since-diff').locator('.ln.add, .ln.del').allTextContents()) expect(line).not.toContain('DEV');
  expect(blobRequests).toEqual([]);
  await row.getByTestId('full-tab').click();
  await expect(row.getByTestId('diff')).toContainText('+line 8 FEAT');   // 빠진 덩어리는 전체 diff 에 있다
});

test('in the block view, a viewed block sharing a hunk with a new one is dimmed', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { head: 'h2', mergeBase: MB2, files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: P3 }], gistFiles: await recordAt(P1, MB1) });
  await open(page);
  const diff = page.getByTestId('file-row').getByTestId('since-diff');
  await expect(diff.locator('.ln.seen')).toHaveText(['-line 8', '+line 8 FEAT']);
  expect(await diff.locator('.ln.seen').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('0.5');
  for (const ln of await diff.locator('.ln', { hasText: 'line 11' }).all()) await expect(ln).not.toHaveClass(/\bseen\b/);
  await expect(diff.locator('.ln', { hasText: 'line 11' })).toHaveCount(2);
});

test('the block notice shows only on the since-viewed tab', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { head: 'h2', mergeBase: MB2, files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: P3 }], gistFiles: await recordAt(P1, MB1) });
  await open(page);
  const row = page.getByTestId('file-row');
  await expect(row.getByTestId('since-blocks')).toBeVisible();
  await row.getByTestId('full-tab').click();
  await expect(row.getByTestId('diff')).toContainText('+line 11 FEAT2');   // 전체 탭이 그려진 뒤에 센다
  await expect(row.getByTestId('since-blocks')).toHaveCount(0);
  await row.getByTestId('since-tab').click();
  await expect(row.getByTestId('since-blocks')).toBeVisible();
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
