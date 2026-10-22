import { test, expect, type Page } from '@playwright/test';

// 로컬 폴더 모드에서 대상(integ → test)을 뒤처진 쪽으로 바꿔 다시 연다.
// integ 기준 merge-base = P, test 기준 = N, 그리고 N 은 P 의 조상이다.
//   w.ts  N..head 에만 있고 P..head 에는 없다(= integ 에 이미 있는 파일)
//   y.ts  P..head 에선 수정, N..head 에선 새 파일
//   z.ts  양쪽 다 수정 — 확인한 뒤 head 에서 바뀐다
type Opts = { ancestor?: boolean };
async function fakeLocal(page: Page, o: Opts = {}) {
  await page.addInitScript((o) => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const w = window as any;
    const oid = (c: string) => c.repeat(40);
    const P = oid('1'), N = oid('2');
    w.__v = { head: oid('f'), z: 'a', failP: false, slowP: false };
    const body = (p: string, x: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,2 +1,2 @@\n ctx\n-old\n+${x}\n`;
    const mod = (p: string, n: string) => `:100644 100644 ${oid('0').slice(1)}9 ${n} M\0${p}\0`;
    const add = (p: string, n: string) => `:000000 100644 ${oid('0')} ${n} A\0${p}\0`;
    const zOid = () => oid(w.__v.z === 'a' ? '5' : '6');
    const forP = () => ({ raw: mod('y.ts', oid('3')) + mod('z.ts', zOid()), patch: body('y.ts', 'y1') + body('z.ts', 'z' + w.__v.z) });
    const forN = () => ({ raw: mod('w.ts', oid('4')) + add('y.ts', oid('3')) + mod('z.ts', zOid()), patch: body('w.ts', 'w1') + body('y.ts', 'y1') + body('z.ts', 'z' + w.__v.z) });
    w.__writes = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) { if (k === 'viewed.device.mac') w.__writes++; return set.call(this, k, v); };
    w.viewedDesktop = {
      getSecret: async () => null, setSecret: async () => {},
      git: {
        pick: async () => null, list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/integ', 'refs/heads/test'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'alice@example.test' } }),
        run: async (_repo: string, op: string, a: string, b: string) => {
          const v = w.__v;
          if (op === 'resolve') return a === 'refs/heads/feat' ? v.head : a === 'refs/heads/integ' ? oid('7') : oid('8');
          if (op === 'mergeBase') {
            if (a === N && b === P) return o.ancestor === false ? oid('9') : N;
            return a === oid('7') ? P : N;
          }
          if (op === 'rawDiff' || op === 'patchDiff') {
            if (a === P) {
              if (v.failP) throw new Error('boom');
              if (v.slowP) await new Promise((r) => setTimeout(r, 6000));
              return forP()[op === 'rawDiff' ? 'raw' : 'patch'];
            }
            return forN()[op === 'rawDiff' ? 'raw' : 'patch'];
          }
          return null;
        },
      },
    };
  }, o);
}

const row = (page: Page, path: string) => page.getByTestId('file-row').filter({ hasText: path });
async function openWith(page: Page, base: 'integ' | 'test', progress?: string) {
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('local-base-select').selectOption(`refs/heads/${base}`);
  await page.getByTestId('open-btn').click();
  if (progress) await expect(page.getByTestId('progress')).toHaveText(progress);
}
// integ 로 열어 y·z 를 확인하고, z 를 head 에서 바꾼다
async function seed(page: Page) {
  await page.goto('/');
  await openWith(page, 'integ', '0 / 2');
  await row(page, 'y.ts').getByTestId('file-check').check();
  await row(page, 'z.ts').getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('2 / 2');
  await page.evaluate(() => { const v = (window as any).__v; v.z = 'b'; v.head = 'e'.repeat(40); });
}

test('after switching to a target behind the old one, files equal to the old target and files reviewed there are viewed', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await openWith(page, 'test', '2 / 3');
  await expect(row(page, 'w.ts')).toHaveAttribute('data-state', 'viewed');
  await expect(row(page, 'y.ts')).toHaveAttribute('data-state', 'viewed');
  await expect(row(page, 'z.ts')).toHaveAttribute('data-state', 'changed-since-viewed');
});

test('carried files are written once and unchecking one keeps it unread after refresh', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  const before = await page.evaluate(() => (window as any).__writes);
  await openWith(page, 'test', '2 / 3');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__writes) - before).toBe(2);   // w, y
  await row(page, 'w.ts').getByTestId('file-check').uncheck();
  await expect(row(page, 'w.ts')).toHaveAttribute('data-state', 'unread');
  await page.getByTestId('refresh-btn').click();
  await page.waitForTimeout(500);
  await expect(row(page, 'w.ts')).toHaveAttribute('data-state', 'unread');
  await expect(page.getByTestId('progress')).toHaveText('1 / 3');
});

test('when the new merge-base is not an ancestor, nothing is carried', async ({ page }) => {
  await fakeLocal(page, { ancestor: false });
  await seed(page);
  const before = await page.evaluate(() => (window as any).__writes);
  await openWith(page, 'test', '0 / 3');
  await expect(row(page, 'w.ts')).toHaveAttribute('data-state', 'unread');
  expect(await page.evaluate(() => (window as any).__writes)).toBe(before);
});

test('a failing P-diff leaves today\'s behavior and the list still shows', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await page.evaluate(() => { (window as any).__v.failP = true; });
  await openWith(page, 'test', '0 / 3');
  await expect(row(page, 'w.ts')).toHaveAttribute('data-state', 'unread');
});

test('a P-diff slower than 5s shows the list at the deadline and drops the late result', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  const before = await page.evaluate(() => (window as any).__writes);
  await page.evaluate(() => { (window as any).__v.slowP = true; });
  await openWith(page, 'test');
  await expect(page.getByTestId('progress')).toHaveText('0 / 3', { timeout: 6000 });
  await expect(row(page, 'w.ts')).toHaveAttribute('data-state', 'unread');
  await page.waitForTimeout(2500);   // 늦은 결과가 도착한 뒤에도
  await expect(row(page, 'w.ts')).toHaveAttribute('data-state', 'unread');
  expect(await page.evaluate(() => (window as any).__writes)).toBe(before);
});
