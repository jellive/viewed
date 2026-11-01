import { test, expect, type Page } from '@playwright/test';

// 로컬 폴더 모드에서 대상을 integ → test 로 옮긴다. head 는 그대로라 결과 파일이 같다. integ 와 test 의 merge-base 는 어느 쪽도 조상이 아니다.
//   a.ts  두 줄 블록을 봤는데 test 에 첫 줄이 이미 있다 — 지금 변경은 전부 그때 본 변경
//   b.ts  test 쪽에서만 지운 줄이 나온다 — 처음 보는 삭제
//   c.ts  그때 지운 줄과 글자는 같은데 다른 자리다
// integ2 는 test 의 후손이라 이어받기 첫 단계가 쓴다. e.ts 는 양쪽 diff 가 같고, w.ts 는 test 쪽에만 있다(= integ2 에 이미 있는 파일)
// feat2 는 feat 와 파일 내용이 같은 다른 브랜치다
async function fakeLocal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const w = window as any;
    const oid = (c: string) => c.repeat(40);
    const INTEG = oid('1'), TEST = oid('2'), INTEG2 = oid('b');
    w.__v = { hang: false, fail: false, withFirstStep: false, moved: false };
    const body = (p: string, h: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${h}\n`;
    const mod = (p: string, n: string) => `:100644 100644 ${oid('0').slice(1)}9 ${n} M\0${p}\0`;
    const abc = { raw: mod('a.ts', oid('3')) + mod('b.ts', oid('4')) + mod('c.ts', oid('5')) };
    const onInteg = () => ({ ...abc,
      patch: body('a.ts', '@@ -108,4 +108,4 @@\n c\n-x\n-y\n+X\n+Y\n d') + body('b.ts', '@@ -1,2 +1,2 @@\n a\n-x\n+y') + body('c.ts', '@@ -1,4 +1,3 @@\n sandbox() {\n-  authorize();\n   run();\n }'),
    });
    const changedOnTest = () => (w.__v.moved ? changedAfterCommit : changedBefore);
    const changedAfterCommit = body('a.ts', '@@ -109,3 +109,3 @@\n X\n-y\n+Y\n d') + body('b.ts', '@@ -1,2 +1,2 @@\n a\n-first time\n+y2') + body('c.ts', '@@ -20,4 +20,3 @@\n production() {\n-  authorize();\n   run();\n }');
    const changedBefore = body('a.ts', '@@ -109,3 +109,3 @@\n X\n-y\n+Y\n d') + body('b.ts', '@@ -1,2 +1,2 @@\n a\n-first time\n+y') + body('c.ts', '@@ -20,4 +20,3 @@\n production() {\n-  authorize();\n   run();\n }');
    const e = { raw: mod('e.ts', oid('6')), patch: body('e.ts', '@@ -1,2 +1,2 @@\n a\n-e\n+E') };
    const wFile = { raw: mod('w.ts', oid('c')), patch: body('w.ts', '@@ -1,2 +1,2 @@\n a\n-w\n+W') };
    const onTest = () => (w.__v.withFirstStep
      ? { raw: abc.raw + e.raw + wFile.raw, patch: changedOnTest() + e.patch + wFile.patch }
      : { ...abc, patch: changedOnTest() });
    const onInteg2 = () => ({ raw: abc.raw + e.raw, patch: changedOnTest() + e.patch });
    w.viewedDesktop = {
      getSecret: async () => null, setSecret: async () => {},
      git: {
        pick: async () => null, list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/feat2', 'refs/heads/integ', 'refs/heads/integ2', 'refs/heads/test'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'alice@example.test' } }),
        run: async (_repo: string, op: string, a: string, b: string) => {
          const v = w.__v;
          if (op === 'resolve') return a === 'refs/heads/feat' ? (v.moved ? oid('e') : oid('f')) : a === 'refs/heads/feat2' ? oid('d') : a === 'refs/heads/integ' ? oid('7') : a === 'refs/heads/integ2' ? oid('a') : oid('8');
          if (op === 'mergeBase') {
            if (a === TEST && b === INTEG2) return TEST;
            return a === oid('7') ? INTEG : a === oid('a') ? INTEG2 : a === oid('8') ? TEST : oid('9');
          }
          if (op === 'rawDiff' || op === 'patchDiff') {
            if (a === INTEG && b !== TEST) {   // 옛 대상의 diff 만 — base 이동 재기(INTEG..TEST)가 마감을 다 쓰면 첫 단계까지 못 간다
              if (v.hang) await new Promise(() => {});
              if (v.fail) throw new Error('boom');
            }
            const d = a === INTEG ? onInteg() : a === INTEG2 ? onInteg2() : onTest();
            return op === 'rawDiff' ? d.raw : d.patch;
          }
          return null;
        },
      },
    };
  });
}

const row = (page: Page, path: string) => page.getByTestId('file-row').filter({ hasText: path });
const setV = (page: Page, v: Record<string, boolean>) => page.evaluate((v) => { Object.assign((window as any).__v, v); }, v);
async function openWith(page: Page, base: 'integ' | 'integ2' | 'test', progress?: string) {
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('local-base-select').selectOption(`refs/heads/${base}`);
  await page.getByTestId('open-btn').click();
  if (progress) await expect(page.getByTestId('progress')).toHaveText(progress);
}
async function seed(page: Page) {
  await page.goto('/');
  await openWith(page, 'integ', '0 / 3');
  for (const p of ['a.ts', 'b.ts', 'c.ts']) await row(page, p).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('3 / 3');
}

test('moving the target carries only files with nothing new to read, and lists them as automatic', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await openWith(page, 'test', '1 / 3');
  await expect(row(page, 'a.ts')).toHaveAttribute('data-state', 'viewed');
  await expect(row(page, 'a.ts').getByTestId('file-state')).toHaveText('Carried over');
  await expect(row(page, 'b.ts')).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row(page, 'c.ts')).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(page.getByTestId('auto-filter')).toHaveText('1 automatic');
});

test('a file with a line never seen shows that line in full and dims the changes already reviewed', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await openWith(page, 'test', '1 / 3');
  const b = row(page, 'b.ts');
  await expect(b.getByTestId('since-blocks')).toContainText('lines you have not seen');
  await expect(b.getByTestId('since-diff').locator('.ln.add:not(.seen), .ln.del:not(.seen)')).toHaveText(['-first time']);
  await expect(b.getByTestId('since-diff').locator('.ln.seen')).toHaveText(['+y']);
  // 글자가 같아도 다른 자리에서 지운 줄은 처음 보는 줄이다
  const c = row(page, 'c.ts');
  await expect(c.getByTestId('since-diff').locator('.ln.del:not(.seen)')).toHaveText(['-  authorize();']);
  // '전체' 탭은 그대로 전부 진하게
  await b.getByTestId('full-tab').click();
  await expect(b.locator('.ln.seen')).toHaveCount(0);
  await expect(b.locator('.ln.add, .ln.del')).toHaveText(['-first time', '+y']);
  // 확인하면 평범한 확인이다
  await b.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('2 / 3');
  await expect(page.getByTestId('auto-filter')).toHaveText('1 automatic');
});

test('another branch with the same file content uses the same rule', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  const records = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('viewed.device.mac') ?? '{}')).length);
  expect(await records()).toBe(3);
  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat2');
  await page.getByTestId('local-base-select').selectOption('refs/heads/test');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 3');
  await expect(row(page, 'a.ts').getByTestId('file-state')).toHaveText('Carried over');
  const b = row(page, 'b.ts');
  await expect(b).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(b.getByTestId('file-state')).toHaveText('Seen on another branch');
  await expect(b.getByTestId('since-blocks')).toContainText('what you viewed on another branch');
  await expect(b.getByTestId('since-diff').locator('.ln.add:not(.seen), .ln.del:not(.seen)')).toHaveText(['-first time']);
  await expect(row(page, 'c.ts').getByTestId('since-diff').locator('.ln.del:not(.seen)')).toHaveText(['-  authorize();']);
  expect(await records()).toBe(4);   // 이어받은 a.ts 만 쓴다. 처음 보는 줄 표시는 저장하지 않는다
  expect(await page.evaluate(() => Object.values<any>(JSON.parse(localStorage.getItem('viewed.device.mac') ?? '{}')).filter((r) => r.via === 'branch').length)).toBe(1);

  // 다시 열어도 같다
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 3');
  await expect(b.getByTestId('file-state')).toHaveText('Seen on another branch');
});

test('new lines found from this branch and from another branch show together', async ({ page }) => {
  await fakeLocal(page);
  await page.goto('/');
  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat2');
  await page.getByTestId('local-base-select').selectOption('refs/heads/integ');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 3');
  await row(page, 'b.ts').getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 3');
  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 3');
  await row(page, 'c.ts').getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('2 / 3');
  // feat2 에서 b.ts 는 자기 기록, c.ts 는 feat 의 기록과 맞댄다
  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat2');
  await page.getByTestId('local-base-select').selectOption('refs/heads/test');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 3');
  await expect(row(page, 'b.ts').getByTestId('since-blocks')).toContainText('unchanged since you viewed');
  await expect(row(page, 'c.ts').getByTestId('since-blocks')).toContainText('what you viewed on another branch');
});

test('a new commit that changes the diff drops the marks instead of pointing at the wrong lines', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await openWith(page, 'test', '1 / 3');
  await expect(row(page, 'b.ts').getByTestId('since-blocks')).toContainText('lines you have not seen');
  await setV(page, { moved: true });
  await page.getByTestId('refresh-btn').click();
  await expect(row(page, 'b.ts').getByTestId('since-blocks')).not.toContainText('lines you have not seen');
  await expect(row(page, 'b.ts').getByTestId('since-diff').locator('.ln.add')).toContainText(['+y2']);
});

test('going back to the old target keeps every file viewed', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await openWith(page, 'test', '1 / 3');
  await openWith(page, 'integ', '3 / 3');
});

test('unchecking a carried file sticks after a refresh and a reopen', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await openWith(page, 'test', '1 / 3');
  await row(page, 'a.ts').getByTestId('file-check').uncheck();
  await expect(row(page, 'a.ts')).toHaveAttribute('data-state', 'unread');
  await page.getByTestId('refresh-btn').click();
  await page.waitForTimeout(300);
  await expect(row(page, 'a.ts')).toHaveAttribute('data-state', 'unread');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 3');
  await expect(row(page, 'a.ts')).toHaveAttribute('data-state', 'unread');
});

test('when the old diff cannot be read, nothing is carried and the list still appears', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await setV(page, { fail: true });
  await openWith(page, 'test', '0 / 3');
  await expect(row(page, 'a.ts')).toHaveAttribute('data-state', 'changed-since-viewed');
});

test('when the old diff never answers, the list appears at the deadline and nothing flips afterwards', async ({ page }) => {
  await fakeLocal(page);
  await seed(page);
  await setV(page, { hang: true });
  await openWith(page, 'test');
  await expect(page.getByTestId('progress')).toHaveText('0 / 3', { timeout: 8000 });
  await setV(page, { hang: false });
  await page.getByTestId('refresh-btn').click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('progress')).toHaveText('0 / 3');
});

test('a second step that runs out of time does not lose what the first step carried', async ({ page }) => {
  await fakeLocal(page);
  await page.goto('/');
  await setV(page, { withFirstStep: true });
  await openWith(page, 'integ2', '0 / 4');
  await row(page, 'e.ts').getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 4');
  await openWith(page, 'integ', '0 / 3');
  await row(page, 'a.ts').getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 3');
  await setV(page, { hang: true });
  await openWith(page, 'test');
  // e.ts 는 diff 가 같고, w.ts 는 첫 단계가 이어받았다. a.ts 를 맞댈 옛 diff 는 끝내 안 온다
  await expect(page.getByTestId('progress')).toHaveText('2 / 5', { timeout: 8000 });
  await expect(row(page, 'w.ts').getByTestId('file-state')).toHaveText('Carried over');
  await expect(row(page, 'a.ts')).toHaveAttribute('data-state', 'changed-since-viewed');
});
