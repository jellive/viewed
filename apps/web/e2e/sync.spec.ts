import { test, expect, type Page } from '@playwright/test';
import { recordKey } from '@viewed/core';
import { mockGitHub, mockBranch, statefulGist, seedSettings, viewedGist, sleep, SETTINGS } from './fixtures';

const files = [
  { filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' },
  { filename: 'b.ts', status: 'modified', sha: 'b1', patch: '@@ -1 +1 @@\n-p\n+q' },
];
const filesB = [
  { filename: 'c.ts', status: 'added', sha: 'c1', patch: '@@ -0,0 +1 @@\n+c' },
  { filename: 'd.ts', status: 'added', sha: 'd1', patch: '@@ -0,0 +1 @@\n+d' },
];
const key = (branch: string, path: string) => recordKey(SETTINGS.secret, 'acme', 'widget', branch, path);

async function open(page: Page, branch = 'feat') {
  await page.goto('/');
  await openBranch(page, branch);
}
async function openBranch(page: Page, branch: string) {
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill(branch);
  await page.getByTestId('open-btn').click();
}
const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name });
const check = (page: Page, name: string) => row(page, name).getByTestId('file-check').check();

test('T1: reopening while a save is in flight keeps the check and the final file has both keys', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  const g = await statefulGist(page, { patch: () => sleep(300), get: () => sleep(800) });
  await open(page);
  await check(page, 'a.ts');
  await page.waitForTimeout(1700);   // 1.5초 디바운스 뒤 PATCH 가 나가 있다
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2', { timeout: 5000 });
  await check(page, 'b.ts');
  await expect.poll(() => g.deviceKeys().length, { timeout: 8000 }).toBe(2);
});

test('T2: a slow save on branch A cannot erase a later check on branch B', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await mockBranch(page, 'feat2', 'h2', filesB);
  const g = await statefulGist(page, { patch: (n) => (n === 0 ? sleep(3500) : Promise.resolve()) });
  await open(page);
  await check(page, 'a.ts');
  await page.waitForTimeout(1700);
  await openBranch(page, 'feat2');
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await check(page, 'c.ts');
  await expect.poll(() => g.deviceKeys().length, { timeout: 12000 }).toBe(2);
  await expect(page.getByTestId('sync-status')).toHaveText('saved', { timeout: 8000 });
  await page.waitForTimeout(3000);   // 늦은 옛 저장이 있다면 이 사이에 도착해 덮어쓴다
  expect(g.deviceKeys().sort()).toEqual([await key('feat', 'a.ts'), await key('feat2', 'c.ts')].sort());
});

test('T3: B check survives when A save succeeds but B saves fail, and is resent after reload', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await mockBranch(page, 'feat2', 'h2', filesB);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let failB = true;
  const g = await statefulGist(page, { patch: async (n) => { if (n === 0) { await held; return; } if (failB) return 500; } });
  await open(page);
  await check(page, 'a.ts');
  await page.waitForTimeout(1700);            // A 의 PATCH 가 걸려 있다
  await openBranch(page, 'feat2');
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await check(page, 'c.ts');
  await page.waitForTimeout(1700);
  release();
  await expect(page.getByTestId('sync-status')).toHaveText('sync failed', { timeout: 8000 });
  failB = false;
  await page.reload();
  await openBranch(page, 'feat2');
  const kc = await key('feat2', 'c.ts');
  await expect.poll(() => g.deviceKeys().includes(kc), { timeout: 8000 }).toBe(true);
  const last = g.patches[g.patches.length - 1].files['device-mac.json'].content;
  expect(last).toContain(kc);
  expect(JSON.parse(last)[kc].viewed).toBe(true);
});

test('T4: a stale gist read for B cannot drop the record A already saved', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await mockBranch(page, 'feat2', 'h2', filesB);
  const g = await statefulGist(page, { patch: () => sleep(1500), get: (n) => (n === 1 ? sleep(2800) : Promise.resolve()) });
  await open(page);
  await check(page, 'a.ts');
  await openBranch(page, 'feat2');             // 이 GET 은 A 저장 전 사본을 들고 늦게 돌아온다
  await expect(page.getByTestId('file-row')).toHaveCount(2, { timeout: 8000 });
  await check(page, 'c.ts');
  await expect.poll(() => g.deviceKeys().length, { timeout: 10000 }).toBe(2);
  await expect(page.getByTestId('sync-status')).toHaveText('saved', { timeout: 8000 });
  await page.waitForTimeout(1500);
  expect(g.deviceKeys()).toHaveLength(2);
  expect(g.deviceKeys()).toContain(await key('feat', 'a.ts'));
});

test('T5: going to settings and back keeps the list and the later save', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  const g = await statefulGist(page);
  await open(page);
  await check(page, 'a.ts');
  await expect(page.getByTestId('sync-status')).toHaveText('saved', { timeout: 5000 });
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await check(page, 'b.ts');
  await expect.poll(() => g.deviceKeys().length, { timeout: 5000 }).toBe(2);
});

test('T6: a pending write that throws never shows complete with unsaved data', async ({ page }) => {
  await seedSettings(page);
  await page.addInitScript(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k.startsWith('viewed.pending.')) throw new DOMException('quota', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  await mockGitHub(page, { files });
  const only = await viewedGist([files[0]]);
  const g = await statefulGist(page, { initial: only });
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await check(page, 'b.ts');
  await expect(page.getByTestId('progress')).toHaveText('2 / 2');
  await expect(page.getByTestId('complete')).toHaveCount(0);
  await expect.poll(() => g.deviceKeys().length, { timeout: 5000 }).toBe(2);
  await expect(page.getByTestId('complete')).toBeVisible();
});

test('T7: a failed save is resent after reload, and a later reload still shows it', async ({ page }) => {
  await seedSettings(page);
  let fail = true;
  await mockGitHub(page, { files });
  const g = await statefulGist(page, { patch: async () => (fail ? 500 : undefined) });
  await open(page);
  await check(page, 'a.ts');
  await expect(page.getByTestId('sync-status')).toHaveText('sync failed', { timeout: 5000 });
  fail = false;
  await page.reload();
  await openBranch(page, 'feat');
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  const ka = await key('feat', 'a.ts');
  await expect.poll(() => g.deviceKeys().includes(ka), { timeout: 5000 }).toBe(true);
  const sent = g.patches[g.patches.length - 1].files['device-mac.json'].content;
  expect(sent).toContain(ka);
  expect(JSON.parse(sent)[ka].viewed).toBe(true);
  await page.reload();
  await openBranch(page, 'feat');
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
});

test('T8: complete stays hidden while the save is in flight', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await statefulGist(page, { patch: () => sleep(2000) });
  await open(page);
  await check(page, 'a.ts');
  await check(page, 'b.ts');
  await expect(page.getByTestId('progress')).toHaveText('2 / 2');
  await expect(page.getByTestId('sync-status')).toHaveText('saving…');
  await expect(page.getByTestId('complete')).toHaveCount(0);
  await page.waitForTimeout(2500);   // 디바운스 1.5초가 지나 저장이 나가 있는 중
  await expect(page.getByTestId('sync-status')).toHaveText('saving…');
  await expect(page.getByTestId('complete')).toHaveCount(0);
  await expect(page.getByTestId('complete')).toBeVisible({ timeout: 8000 });
});

test('T9: an older save returning does not mark saved while a newer one is pending', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  const g = await statefulGist(page, { patch: () => sleep(2000) });
  await open(page);
  await check(page, 'a.ts');
  await page.waitForTimeout(1700);   // 첫 저장이 나가 있다 (3.5초에 돌아옴)
  await check(page, 'b.ts');
  await page.waitForTimeout(2200);   // 첫 저장이 돌아온 뒤
  await expect(page.getByTestId('sync-status')).toHaveText('saving…');
  await expect.poll(() => g.deviceKeys().length, { timeout: 8000 }).toBe(2);
  await expect(page.getByTestId('sync-status')).toHaveText('saved', { timeout: 5000 });
});
