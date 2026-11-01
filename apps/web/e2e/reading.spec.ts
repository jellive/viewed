import { test, expect, type Page } from '@playwright/test';

// 긴 파일을 읽는 화면. f.ts 는 200줄에서 100번째 줄만 바꿨고, g.ts 는 짧은 수정, n.ts 는 새 파일, p.png 는 바이너리다
const LINES = 200;
async function fakeLocal(page: Page) {
  await page.addInitScript((LINES) => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const w = window as any;
    const oid = (c: string) => c.repeat(40);
    const text = (n: number, at?: number, s?: string) => Array.from({ length: n }, (_, i) => (i + 1 === at ? s : `line ${i + 1}`));
    w.__asks = [];
    // 테스트가 바꾸는 저장소 상태. changed = 100번째 줄의 지금 내용
    w.__v = { head: oid('f'), changed: 'LINE 100', fail: false, huge: false, calls: 0 };
    const blobOf = (s: string) => (s === 'LINE 100' ? oid('3') : oid('4'));
    const short = (s: string) => `@@ -97,7 +97,7 @@\n line 97\n line 98\n line 99\n-line 100\n+${s}\n line 101\n line 102\n line 103\n`;
    const head = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n`;
    const entries = () => `:100644 100644 ${oid('0').slice(1)}1 ${blobOf(w.__v.changed)} M\0f.ts\0` +
      `:100644 100644 ${oid('0').slice(1)}2 ${oid('5')} M\0g.ts\0` +
      `:000000 100644 ${oid('0')} ${oid('6')} A\0n.ts\0` +
      `:100644 100644 ${oid('0').slice(1)}3 ${oid('7')} M\0p.png\0`;
    const patch = () => head('f.ts') + short(w.__v.changed) +
      head('g.ts') + '@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n' +
      head('n.ts') + '@@ -0,0 +1,1 @@\n+fresh\n' +
      'diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n';
    w.viewedDesktop = {
      getSecret: async () => null, setSecret: async () => {},
      git: {
        pick: async () => null, list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/main'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'a@example.test' } }),
        run: async (_repo: string, op: string, a: string, b: string, c: string) => {
          const v = w.__v;
          if (op === 'resolve') return a === 'refs/heads/feat' ? v.head : oid('1');
          if (op === 'mergeBase') return oid('2');
          if (op === 'rawDiff') return entries();
          if (op === 'patchDiff') return patch();
          if (op === 'blob') return (a === oid('3') ? text(LINES, 100, 'LINE 100') : text(LINES, 100, v.changed)).join('\n') + '\n';
          if (op === 'fileDiff') {
            v.calls++; v.last = { a, b, c };
            await new Promise((r) => setTimeout(r, v.delay ?? 30));
            if (v.fail) throw new Error('boom');
            if (c !== 'f.ts') return head(c) + '@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n';
            const n = v.huge ? 25000 : LINES;
            const body = text(n).flatMap((l, i) => (i + 1 === 100 ? ['-line 100', `+${v.changed}`] : [` ${l}`]));
            return head('f.ts') + `@@ -1,${n} +1,${n} @@\n` + body.join('\n') + '\n';
          }
          return null;
        },
      },
      ask: {
        start: (req: unknown) => new Promise(() => { w.__asks.push(req); }),
        cancel: async () => {},
        onProgress: () => () => {},
      },
    };
  }, LINES);
}

const row = (page: Page, path: string) => page.getByTestId('file-row').filter({ hasText: path });
async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 4');
}
const lastCall = (page: Page) => page.evaluate(() => (window as any).__v.last);

test.describe('whole file', () => {
  test('shows every line of the file on demand and goes back, and that does not change whether the file counts as viewed', async ({ page }) => {
    await fakeLocal(page);
    await open(page);
    const f = row(page, 'f.ts');
    await expect(f.getByTestId('diff')).toContainText('+LINE 100');
    await expect(f.locator('.ln.ctx')).toHaveCount(6);
    await f.getByTestId('context-toggle').click();
    await expect(f.locator('.ln.ctx')).toHaveCount(LINES - 1);
    await expect(f.locator('.ln.ctx').first()).toHaveAttribute('data-n', '1');
    await expect(f.locator('.ln.ctx').last()).toHaveAttribute('data-n', String(LINES));
    await expect(f.locator('.ln.del')).toHaveText(['-line 100']);
    await expect(f.locator('.ln.add')).toHaveText(['+LINE 100']);
    // 보이는 리뷰의 merge-base·head 로 그 파일만 읽는다
    expect(await lastCall(page)).toEqual({ a: '2'.repeat(40), b: 'f'.repeat(40), c: 'f.ts' });
    await expect(page.getByTestId('progress')).toHaveText('0 / 4');

    // 켠 채로 체크해도 지문은 그대로 — 다시 읽어도 확인함이다
    await f.getByTestId('file-check').check();
    await expect(page.getByTestId('progress')).toHaveText('1 / 4');
    await page.getByTestId('refresh-btn').click();
    await expect(f).toHaveAttribute('data-state', 'viewed');
    await expect(page.getByTestId('progress')).toHaveText('1 / 4');

    await f.getByTestId('file-expand').click();
    await f.getByTestId('context-toggle').click();
    await expect(f.locator('.ln.ctx')).toHaveCount(LINES - 1);
    await f.getByTestId('context-toggle').click();
    await expect(f.locator('.ln.ctx')).toHaveCount(6);
  });

  test('is offered only when there is more of the file to show', async ({ page }) => {
    await fakeLocal(page);
    await open(page);
    await expect(row(page, 'f.ts').getByTestId('context-toggle')).toHaveCount(1);
    await expect(row(page, 'g.ts').getByTestId('context-toggle')).toHaveCount(1);
    await expect(row(page, 'n.ts').getByTestId('context-toggle')).toHaveCount(0);   // 새 파일은 diff 가 곧 파일 전체
    await expect(row(page, 'p.png').getByTestId('context-toggle')).toHaveCount(0);  // 바이너리
  });

  test('keeps showing the changes when the file cannot be read or is too large', async ({ page }) => {
    await fakeLocal(page);
    await open(page);
    const f = row(page, 'f.ts');
    await page.evaluate(() => { (window as any).__v.fail = true; });
    await f.getByTestId('context-toggle').click();
    await expect(f.getByTestId('context-note')).toHaveText("Couldn't read the whole file. Showing the changes only.");
    await expect(f.locator('.ln.ctx')).toHaveCount(6);
    await f.getByTestId('context-toggle').click();
    await expect(f.getByTestId('context-note')).toHaveCount(0);

    await page.evaluate(() => { const v = (window as any).__v; v.fail = false; v.huge = true; });
    await f.getByTestId('context-toggle').click();
    await expect(f.getByTestId('context-note')).toHaveText('This file is too large to show whole. Showing the changes only.');
    await expect(f.locator('.ln.ctx')).toHaveCount(6);
  });

  test('re-reads for the new commit instead of showing the old file', async ({ page }) => {
    await fakeLocal(page);
    await open(page);
    const f = row(page, 'f.ts');
    await f.getByTestId('context-toggle').click();
    await expect(f.locator('.ln.add')).toHaveText(['+LINE 100']);
    await page.evaluate(() => { const v = (window as any).__v; v.head = 'e'.repeat(40); v.changed = 'NEWER 100'; v.delay = 800; });
    await page.getByTestId('refresh-btn').click();
    // 새로 읽는 동안에도 옛 파일을 안 보인다 — 지금 diff 를 보인다
    await expect(f.locator('.ln.add')).toHaveText(['+NEWER 100']);
    await expect(f.locator('.ln.ctx')).toHaveCount(6);
    await expect(f.locator('.ln.ctx')).toHaveCount(LINES - 1);
    await expect(f.locator('.ln.add')).toHaveText(['+NEWER 100']);
    expect((await lastCall(page)).b).toBe('e'.repeat(40));
  });

  test('sits on the full diff tab of a file changed since viewed, not on the since-viewed tab', async ({ page }) => {
    await fakeLocal(page);
    await open(page);
    const f = row(page, 'f.ts');
    await f.getByTestId('file-check').check();
    await page.evaluate(() => { const v = (window as any).__v; v.head = 'e'.repeat(40); v.changed = 'NEWER 100'; });
    await page.getByTestId('refresh-btn').click();
    await expect(f).toHaveAttribute('data-state', 'changed-since-viewed');
    await expect(f.getByTestId('since-diff')).toBeVisible();
    await expect(f.getByTestId('context-toggle')).toHaveCount(0);
    await f.getByTestId('full-tab').click();
    await f.getByTestId('context-toggle').click();
    await expect(f.locator('.ln.ctx')).toHaveCount(LINES - 1);
  });

  test('a line outside the short diff can be asked about, at its own line number', async ({ page }) => {
    await fakeLocal(page);
    await open(page);
    const f = row(page, 'f.ts');
    await f.getByTestId('context-toggle').click();
    await f.locator('.ln.ctx[data-n="5"]').hover();
    await f.locator('.ln.ctx[data-n="5"]').getByTestId('ask-btn').click();
    await page.getByTestId('thread-input').fill('why?');
    await page.getByTestId('thread-input').press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__asks.length)).toBe(1);
    const req = await page.evaluate(() => (window as any).__asks[0]);
    expect(req).toMatchObject({ path: 'f.ts', side: 'R', line: 5, lineText: 'line 5' });
  });
});
