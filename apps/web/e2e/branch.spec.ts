import { test, expect, type Page } from '@playwright/test';

// 로컬 폴더 모드에서 같은 일을 새 이름 브랜치(feat → feat2)로 옮겨 연다. 기록 키에 브랜치가 들어 그대로면 전부 안 봄이 된다.
//   a.ts  두 브랜치 diff 가 똑같다
//   b.ts  feat2 가 덩어리 하나(+B)를 더했다
//   c.ts  같은 파일을 전혀 다르게 고쳤다
//   e.ts  feat2 가 feat 에서 본 덩어리 하나만 남겼다(지문은 다르다)
async function fakeLocal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const w = window as any;
    const oid = (c: string) => c.repeat(40);
    const hunk = (at: number, from: string, to: string) => `@@ -${at},3 +${at},3 @@\n c${at}\n-${from}\n+${to}\n c${at + 2}\n`;
    const X = hunk(1, 'a', 'A'), Y = hunk(10, 'b', 'B'), Z = hunk(20, 'c', 'C'), W = hunk(30, 'd', 'D');
    // head → [경로, 덩어리들, 새 blob]
    const files: Record<string, [string, string, string][]> = {
      [oid('f')]: [['a.ts', X, oid('3')], ['b.ts', X, oid('4')], ['c.ts', Z, oid('5')], ['e.ts', X + Y, oid('6')]],
      [oid('e')]: [['a.ts', X, oid('3')], ['b.ts', X + Y, oid('7')], ['c.ts', W, oid('8')], ['e.ts', X, oid('9')]],
    };
    const raw = (h: string) => files[h].map(([p, , n]) => `:100644 100644 ${'0'.repeat(39)}1 ${n} M\0${p}\0`).join('');
    const patch = (h: string) => files[h].map(([p, d]) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${d}`).join('');
    w.viewedDesktop = {
      getSecret: async () => null, setSecret: async () => {},
      git: {
        pick: async () => null, list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/feat2', 'refs/heads/main'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'alice@example.test' } }),
        run: async (_repo: string, op: string, a: string, b: string) => {
          if (op === 'resolve') return a === 'refs/heads/feat' ? oid('f') : a === 'refs/heads/feat2' ? oid('e') : oid('1');
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

test('a branch opened under a new name keeps what was viewed on the old one: the same diff stays viewed, a partly seen file shows only the unseen part', async ({ page }) => {
  await fakeLocal(page);
  await page.goto('/');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 4');
  for (const p of ['a.ts', 'b.ts', 'c.ts', 'e.ts']) await row(page, p).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('4 / 4');

  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat2');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 4');
  await expect(row(page, 'a.ts')).toHaveAttribute('data-state', 'viewed');
  const b = row(page, 'b.ts');
  await expect(b).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(b.getByTestId('file-state')).toHaveText('Seen on another branch');
  await expect(b.getByTestId('since-blocks')).toContainText('some of these changes on another branch');
  await expect(b.getByTestId('since-diff')).toContainText('+B');
  await expect(b.getByTestId('since-diff')).not.toContainText('+A');   // feat 에서 본 덩어리는 빠진다
  await expect(row(page, 'c.ts')).toHaveAttribute('data-state', 'unread');
  // 본 덩어리뿐이어도 지문이 다르면 확인함이 아니다 — 같은 변경이 파일의 다른 곳에 있을 수 있어, 빼지 않고 전부 흐리게
  const e = row(page, 'e.ts');
  await expect(e).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(e.getByTestId('since-blocks')).toContainText('every one of these changes');
  await expect(e.getByTestId('since-diff').locator('.ln.add, .ln.del')).toHaveText(['-a', '+A']);
  await expect(e.getByTestId('since-diff').locator('.ln.seen')).toHaveText(['-a', '+A']);
  // 완전히 같은 a.ts 만 feat2 기록으로 남는다(feat 4 + 1). 일부 겹침은 쓰지 않는다
  expect(await records(page)).toBe(5);

  // 다시 열어도 같다 — 저장한 a.ts 와, 다시 찾은 b.ts
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 4');
  await expect(b.getByTestId('file-state')).toHaveText('Seen on another branch');
  await b.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('2 / 4');
  expect(await records(page)).toBe(6);
});

test('a record of the open branch, even an uncheck, wins over a check on another branch', async ({ page }) => {
  await fakeLocal(page);
  await page.goto('/');
  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat2');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 4');
  // feat2 에서 a.ts 를 체크했다 푼다 — 이 브랜치의 기록(안 봄)이 생긴다
  await row(page, 'a.ts').getByTestId('file-check').check();
  await row(page, 'a.ts').getByTestId('file-check').uncheck();
  await expect(page.getByTestId('progress')).toHaveText('0 / 4');
  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 4');
  await row(page, 'a.ts').getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 4');
  await page.getByTestId('local-branch-select').selectOption('refs/heads/feat2');
  await page.getByTestId('open-btn').click();
  // 이 브랜치에서 푼 기록이 다른 브랜치의 확인보다 이긴다
  await expect(page.getByTestId('progress')).toHaveText('0 / 4');
  await expect(row(page, 'a.ts')).toHaveAttribute('data-state', 'unread');
});

// 이 브랜치 기록의 base 가 P → N 으로 움직였고 그 이동이 f.ts 를 안 건드렸다. f.ts 는 같은 문맥의 같은 변경을 다른 줄로 옮겼다 —
// base 이동을 재면 줄 단위 '확인 후 변경', 못 재면 블록 판정이 확인함으로 숨긴다. 다른 브랜치 찾기가 마감을 다 써도 base 이동은 먼저 잰다
async function fakeMoved(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const w = window as any;
    const oid = (c: string) => c.repeat(40);
    const P = oid('1'), N = oid('2');
    w.__v = { head: oid('f'), slow: false };
    // 다른 브랜치(other) 키를 만드는 HMAC 만 늦춘다 — 다른 브랜치 찾기만 느려진다
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    (crypto.subtle as any).sign = async (alg: any, key: CryptoKey, data: BufferSource) => {
      if (w.__v.slow && new TextDecoder().decode(data as Uint8Array).includes('refs/heads/other')) await new Promise((r) => setTimeout(r, 7000));
      return sign(alg, key, data);
    };
    const f = (at: number) => `@@ -${at},3 +${at},3 @@\n c1\n-a\n+A\n c3\n`;
    const files = () => {
      const moved = w.__v.head !== oid('f');
      return [['f.ts', f(moved ? 5 : 1), oid(moved ? '4' : '3')], ['g.ts', `@@ -1,3 +1,3 @@\n g1\n-g\n+G\n g3\n`, oid('5')]];
    };
    w.viewedDesktop = {
      getSecret: async () => null, setSecret: async () => {},
      git: {
        pick: async () => null, list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/integ', 'refs/heads/main', 'refs/heads/other'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'alice@example.test' } }),
        run: async (_repo: string, op: string, a: string, b: string) => {
          if (op === 'resolve') return a === 'refs/heads/feat' ? w.__v.head : a === 'refs/heads/integ' ? oid('7') : oid('8');
          if (op === 'mergeBase') return a === oid('7') ? P : N;
          // base 이동이 아무 파일도 안 건드렸다. 진짜 IPC 처럼 시간이 걸린다 — 마감이 0 이면 못 받는다
          if (op === 'rawDiff' && a === P && b === N) { await new Promise((r) => setTimeout(r, 50)); return ''; }
          if (op === 'rawDiff') return files().map(([p, , n]) => `:100644 100644 ${'0'.repeat(39)}1 ${n} M\0${p}\0`).join('');
          if (op === 'patchDiff') return files().map(([p, d]) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${d}`).join('');
          if (op === 'blob') return a === oid('3') ? 'c1\nA\nc3\nx\nx\nx\n' : 'x\nx\nx\nx\nc1\nA\nc3\n';
          return null;
        },
      },
    };
  });
}

test('a slow search of other branches does not starve the base-move check of the open branch\'s own records', async ({ page }) => {
  await fakeMoved(page);
  await page.goto('/');
  await page.getByTestId('local-base-select').selectOption('refs/heads/integ');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await row(page, 'f.ts').getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await page.evaluate(() => { const v = (window as any).__v; v.head = 'e'.repeat(40); v.slow = true; });
  await page.getByTestId('local-base-select').selectOption('refs/heads/main');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2', { timeout: 10000 });
  await expect(row(page, 'f.ts')).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row(page, 'f.ts').getByTestId('since-blocks')).toHaveCount(0);   // 블록 판정이 아니라 줄 단위
});
