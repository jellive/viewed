import { test, expect, type Page } from '@playwright/test';

// feat 에서 전부 확인한 뒤 feat2 를 연다. 화면을 연 채로 feat2 에 새 커밋이 생기면:
//   a.ts  두 브랜치 diff 가 같다
//   g.ts  처음 열 때 feat 와 일부만 겹친다 — 새 커밋 뒤에도 안 본 블록만 보여야 한다
//   c.ts  처음 열 때는 feat 와 전혀 다르게 고쳤다. 새 커밋 뒤에는 feat 와 diff 가 같아진다 — 이미 보이는 파일이라 안 뒤집혀야 한다
//   n.ts  새 커밋으로 처음 나타나고 feat 와 diff 가 같다
//   m.ts  새 커밋으로 처음 나타나고 feat 와 일부만 겹친다
//   p.ts  새 커밋으로 처음 나타나고 어느 브랜치에서도 본 적 없다
async function fakeLocal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const w = window as any;
    const oid = (c: string) => c.repeat(40);
    const hunk = (at: number, from: string, to: string) => `@@ -${at},3 +${at},3 @@\n c${at}\n-${from}\n+${to}\n c${at + 2}\n`;
    const X = hunk(1, 'a', 'A'), Y = hunk(10, 'b', 'B'), Z = hunk(20, 'c', 'C'), W = hunk(30, 'd', 'D');
    w.__v = { head: oid('e') };
    // head → [경로, 덩어리들, 새 blob]
    const files: Record<string, [string, string, string][]> = {
      [oid('f')]: [['a.ts', X, oid('3')], ['c.ts', X, oid('4')], ['g.ts', X + Y, oid('a')], ['n.ts', Y, oid('5')], ['m.ts', X + Y, oid('6')]],
      [oid('e')]: [['a.ts', X, oid('3')], ['c.ts', Z, oid('7')], ['g.ts', X + Z, oid('b')]],
      [oid('d')]: [['a.ts', X, oid('3')], ['c.ts', X, oid('4')], ['g.ts', X + Z, oid('b')], ['n.ts', Y, oid('5')], ['m.ts', X + W, oid('8')], ['p.ts', Z, oid('9')]],
    };
    const raw = (h: string) => files[h].map(([p, , n]) => `:100644 100644 ${'0'.repeat(39)}1 ${n} M\0${p}\0`).join('');
    const patch = (h: string) => files[h].map(([p, d]) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${d}`).join('');
    w.viewedDesktop = {
      getSecret: async () => null, setSecret: async () => {},
      git: {
        pick: async () => null, list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/feat2', 'refs/heads/main'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'alice@example.test' } }),
        run: async (_repo: string, op: string, a: string, b: string) => {
          if (op === 'resolve') return a === 'refs/heads/feat' ? oid('f') : a === 'refs/heads/feat2' ? w.__v.head : oid('1');
          if (op === 'mergeBase') return oid('2');
          if (op === 'rawDiff') return raw(b);
          if (op === 'patchDiff') return patch(b);
          return null;
        },
      },
    };
  });
}

const row = (page: Page, path: string) => page.getByTestId('file-row').filter({ hasText: path });
const records = (page: Page) => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('viewed.device.mac') ?? '{}')).length);

async function openFeat2(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 5');
  for (const p of ['a.ts', 'c.ts', 'g.ts', 'n.ts', 'm.ts']) await row(page, p).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('5 / 5');
  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat2');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 3');
  await expect(row(page, 'c.ts')).toHaveAttribute('data-state', 'unread');
  await expect(row(page, 'g.ts').getByTestId('file-state')).toHaveText('Seen on another branch');
}

for (const how of ['live poll', 'refresh click'] as const) {
  test(`a file that first appears on a ${how} looks for checks on other branches, and files already on screen do not flip`, async ({ page }) => {
    await fakeLocal(page);
    await openFeat2(page);
    await page.evaluate(() => { (window as any).__v.head = 'd'.repeat(40); });
    if (how === 'refresh click') await page.getByTestId('refresh-btn').click();
    await expect(page.getByTestId('progress')).toHaveText('2 / 6', { timeout: 8000 });
    await expect(row(page, 'n.ts')).toHaveAttribute('data-state', 'viewed');
    await expect(row(page, 'n.ts').getByTestId('file-state')).toHaveText('Carried over');
    const m = row(page, 'm.ts');
    await expect(m).toHaveAttribute('data-state', 'changed-since-viewed');
    await expect(m.getByTestId('file-state')).toHaveText('Seen on another branch');
    await expect(m.getByTestId('since-diff')).toContainText('+D');
    await expect(m.getByTestId('since-diff')).not.toContainText('+A');
    await expect(row(page, 'g.ts').getByTestId('file-state')).toHaveText('Seen on another branch');   // 앞서 찾은 것이 새로 찾은 것에 안 덮인다
    await expect(row(page, 'p.ts')).toHaveAttribute('data-state', 'unread');
    await expect(row(page, 'c.ts')).toHaveAttribute('data-state', 'unread');   // 이미 보이던 파일 — diff 가 같아졌어도 저절로 안 넘어간다
    expect(await records(page)).toBe(5 + 2);   // feat 5 + feat2 의 a.ts, n.ts
  });
}

test('reopening looks everything up again, so the file left alone on screen is found then', async ({ page }) => {
  await fakeLocal(page);
  await openFeat2(page);
  await page.evaluate(() => { (window as any).__v.head = 'd'.repeat(40); });
  await page.getByTestId('refresh-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('2 / 6');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('3 / 6');
  await expect(row(page, 'c.ts')).toHaveAttribute('data-state', 'viewed');
});
