import { test, expect, type Page } from '@playwright/test';

// 긴 파일을 읽는 화면. f.ts 는 200줄에서 100번째 줄만 바꿨고, g.ts 는 짧은 수정, n.ts 는 새 파일, p.png 는 바이너리다.
// z.ts 는 맨 끝의 긴 diff — 위 파일을 접어도 문서가 길게 남아, 브라우저의 스크롤 끝 맞춤이 대신 맞춰 주는 일이 없다
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
      `:100644 100644 ${oid('0').slice(1)}3 ${oid('7')} M\0p.png\0` +
      `:100644 100644 ${oid('0').slice(1)}4 ${oid('8')} M\0z.ts\0`;
    const patch = () => head('f.ts') + short(w.__v.changed) +
      head('g.ts') + '@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n' +
      head('n.ts') + '@@ -0,0 +1,1 @@\n+fresh\n' +
      'diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n' +
      head('z.ts') + `@@ -1,${LINES} +1,${LINES} @@\n-old\n+new\n` + text(LINES - 1).map((l) => ` ${l}`).join('\n') + '\n';
    w.viewedDesktop = {
      getSecret: async () => null, setSecret: async () => {},
      git: {
        pick: async () => null, list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/feat2', 'refs/heads/main'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'a@example.test' } }),
        run: async (_repo: string, op: string, a: string, b: string, c: string) => {
          const v = w.__v;
          if (op === 'resolve') return a === 'refs/heads/feat' || a === 'refs/heads/feat2' ? v.head : oid('1');
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
  await expect(page.getByTestId('progress')).toHaveText('0 / 5');
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
    await expect(page.getByTestId('progress')).toHaveText('0 / 5');

    // 켠 채로 체크해도 지문은 그대로 — 다시 읽어도 확인함이다
    await f.getByTestId('file-check').check();
    await expect(page.getByTestId('progress')).toHaveText('1 / 5');
    await page.getByTestId('refresh-btn').click();
    await expect(f).toHaveAttribute('data-state', 'viewed');
    await expect(page.getByTestId('progress')).toHaveText('1 / 5');

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

// 긴 diff 를 읽는 중에도 파일 이름과 체크칸이 보인다. 체크칸이 진짜 눌리는 자리에 있는지는 elementFromPoint 로 본다
test.describe('file head', () => {
  const rect = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const barBottom = async (page: Page) => (await rect(page, '.progress')).bottom;
  const headOf = (path: string) => `li.file:has(.path:text-is("${path}")) .file-head`;
  const rowOf = (path: string) => `li.file:has(.path:text-is("${path}"))`;
  // f.ts 를 전체로 펼치고 그 한가운데로 스크롤한다 — 머리의 원래 자리는 화면 위로 올라가 있다
  async function readingMiddle(page: Page) {
    await open(page);
    const f = row(page, 'f.ts');
    await f.getByTestId('context-toggle').click();
    await expect(f.locator('.ln.ctx')).toHaveCount(LINES - 1);
    await f.locator('.ln.ctx[data-n="90"]').evaluate((e) => e.scrollIntoView({ block: 'center' }));
    expect((await rect(page, rowOf('f.ts'))).top).toBeLessThan(0);
    return f;
  }
  async function expectCheckReachable(page: Page, path: string) {
    const ok = await row(page, path).getByTestId('file-check').evaluate((input) => {
      const r = input.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === input;
    });
    expect(ok).toBe(true);
  }

  test('stays right under the progress bar and can be clicked while reading the middle of a long diff', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await fakeLocal(page);
    const f = await readingMiddle(page);
    expect((await rect(page, '.progress')).top).toBe(0);
    expect((await rect(page, headOf('f.ts'))).top).toBeCloseTo(await barBottom(page), 0);
    await expectCheckReachable(page, 'f.ts');
    await expect(f.locator('.path')).toBeInViewport();
    // 다음 파일로 넘어가면 그 파일 머리가 그 자리를 잇는다
    await row(page, 'g.ts').locator('.ln.add').evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await expectCheckReachable(page, 'g.ts');
  });

  test('follows the height of the progress bar when a narrow window wraps it', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await fakeLocal(page);
    await readingMiddle(page);
    const wide = await barBottom(page);
    await page.setViewportSize({ width: 480, height: 600 });
    await row(page, 'f.ts').locator('.ln.ctx[data-n="90"]').evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await expect.poll(() => barBottom(page)).toBeGreaterThan(wide);   // 좁으면 검색칸이 아랫줄로 내려간다
    await expect.poll(async () => Math.round((await rect(page, headOf('f.ts'))).top)).toBe(Math.round(await barBottom(page)));
    await expectCheckReachable(page, 'f.ts');
  });

  test('checking from the middle of a long diff lands on the next file, not several files later', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await fakeLocal(page);
    const f = await readingMiddle(page);
    await f.getByTestId('file-check').check();
    await expect(f.locator('.file-body')).toHaveCount(0);
    expect((await rect(page, rowOf('f.ts'))).top).toBeCloseTo(await barBottom(page), 0);
    await expect(row(page, 'g.ts').locator('.path')).toBeInViewport();
    await expectCheckReachable(page, 'g.ts');
  });

  test('collapsing with the chevron from the middle of a long diff does the same', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await fakeLocal(page);
    const f = await readingMiddle(page);
    await f.getByTestId('file-expand').click();
    await expect(f.locator('.file-body')).toHaveCount(0);
    expect((await rect(page, rowOf('f.ts'))).top).toBeCloseTo(await barBottom(page), 0);
    await expect(row(page, 'g.ts').locator('.path')).toBeInViewport();
  });

  test('checking a file whose head is in its normal place does not move the page', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await fakeLocal(page);
    await open(page);
    const before = await page.evaluate(() => window.scrollY);
    await row(page, 'f.ts').getByTestId('file-check').check();
    await expect(row(page, 'f.ts').locator('.file-body')).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });
});

test('the recent menu opens over the progress bar, not under it', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.addInitScript(() => {
    const history = Array.from({ length: 8 }, (_, i) => ({ repo: '/r/a', branch: 'refs/heads/feat', base: `refs/heads/b${i}` }));
    localStorage.setItem('viewed.recent', JSON.stringify({ history }));
  });
  await fakeLocal(page);
  await open(page);
  await page.getByTestId('local-recent').locator('summary').click();
  const covered = await page.getByTestId('recent-item').evaluateAll((items) => {
    const bar = document.querySelector('.progress')!.getBoundingClientRect();
    const over = items.filter((e) => { const r = e.getBoundingClientRect(); return r.top < bar.bottom && r.bottom > bar.top; });
    return { over: over.length, hitsItem: over.every((e) => { const r = e.getBoundingClientRect(); const y = Math.max(r.top, bar.top) + 2; return e.contains(document.elementFromPoint(r.left + r.width / 2, y)); }) };
  });
  expect(covered.over).toBeGreaterThan(0);   // 겹치는 자리가 있어야 이 테스트가 뜻이 있다
  expect(covered.hitsItem).toBe(true);
});

test('a question being written survives turning the whole file on and off', async ({ page }) => {
  await fakeLocal(page);
  await open(page);
  const f = row(page, 'f.ts');
  await f.locator('.ln.add').hover();
  await f.locator('.ln.add').getByTestId('ask-btn').click();
  await page.getByTestId('thread-input').fill('why this line?');
  await f.getByTestId('context-toggle').click();
  await expect(f.locator('.ln.ctx')).toHaveCount(LINES - 1);
  await expect(page.getByTestId('thread-input')).toHaveValue('why this line?');
  await f.getByTestId('context-toggle').click();
  await expect(f.locator('.ln.ctx')).toHaveCount(6);
  await expect(page.getByTestId('thread-input')).toHaveValue('why this line?');
});

// 체크로 행이 목록에서 사라지는 두 경우 — 접기와 달리 행이 없어져도 화면이 몇 파일 뒤로 튀지 않는다
test.describe('a row leaving a filtered list', () => {
  const top = (page: Page, path: string) => row(page, path).evaluate((e) => e.getBoundingClientRect().top);
  const bar = (page: Page) => page.locator('.progress').evaluate((e) => e.getBoundingClientRect().bottom);

  test('checking from the middle of a long diff with viewed files hidden lands on the next file', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await fakeLocal(page);
    await open(page);
    await page.getByTestId('filter-unviewed').check();
    const f = row(page, 'f.ts');
    await f.getByTestId('context-toggle').click();
    await expect(f.locator('.ln.ctx')).toHaveCount(LINES - 1);
    await f.locator('.ln.ctx[data-n="90"]').evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await f.getByTestId('file-check').click();
    await expect(page.getByTestId('file-row').filter({ hasText: 'f.ts' })).toHaveCount(0);
    await expect(row(page, 'g.ts').locator('.path')).toBeInViewport();
    expect(Math.abs(await top(page, 'g.ts') - await bar(page))).toBeLessThan(40);
  });

  test('unchecking from the middle of a long diff in the automatic list lands on the next file', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await fakeLocal(page);
    await open(page);
    for (const p of ['f.ts', 'g.ts', 'n.ts', 'p.png', 'z.ts']) await row(page, p).getByTestId('file-check').check();
    await expect(page.getByTestId('progress')).toHaveText('5 / 5');
    await page.getByTestId('local-branch-select').selectOption('refs/heads/feat2');
    await page.getByTestId('open-btn').click();
    await expect(page.getByTestId('auto-filter')).toHaveText('5 automatic');
    await page.getByTestId('auto-filter').click();
    // 아래에 펼친 긴 파일이 있어야 문서가 길게 남는다 — 짧으면 브라우저의 스크롤 끝 맞춤이 대신 맞춰 준다
    await row(page, 'z.ts').getByTestId('file-expand').click();
    const f = row(page, 'f.ts');
    await f.getByTestId('file-expand').click();
    await f.getByTestId('context-toggle').click();
    await expect(f.locator('.ln.ctx')).toHaveCount(LINES - 1);
    await f.locator('.ln.ctx[data-n="90"]').evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await f.getByTestId('file-check').click();
    await expect(page.getByTestId('file-row').filter({ hasText: 'f.ts' })).toHaveCount(0);
    await expect(row(page, 'g.ts').locator('.path')).toBeInViewport();
    expect(Math.abs(await top(page, 'g.ts') - await bar(page))).toBeLessThan(40);
  });
});

// 생성 SQL 같은 큰 diff 는 처음에 접어 둔다 — 2026-11-01 실사용에서 두 파일로 5만 5천 줄을 그려 체크 한 번에 0.5~0.8초 걸렸다
test.describe('a large diff', () => {
  const N = 2500;
  async function fakeBig(page: Page) {
    await page.addInitScript((N) => {
      localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
      const w = window as any;
      const oid = (c: string) => c.repeat(40);
      const head = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n`;
      const lines = (n: number, s: string) => Array.from({ length: n }, (_, i) => `+${s} ${i}`).join('\n');
      w.__v = { head: oid('f'), tail: 'x' };
      const raw = () => `:000000 100644 ${oid('0')} ${w.__v.tail === 'x' ? oid('3') : oid('6')} A\0big.sql\0:000000 100644 ${oid('0')} ${oid('4')} A\0edge.sql\0:100644 100644 ${oid('0').slice(1)}1 ${oid('5')} M\0s.ts\0`;
      const patch = () => head('big.sql') + `@@ -0,0 +1,${N} @@\n${lines(N - 1, 'b')}\n+${w.__v.tail}\n` +
        head('edge.sql') + `@@ -0,0 +1,1999 @@\n${lines(1999, 'e')}\n` +
        head('s.ts') + '@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n';
      w.viewedDesktop = {
        getSecret: async () => null, setSecret: async () => {},
        git: {
          pick: async () => null, list: async () => ['/r/a'],
          info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/main'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'a@example.test' } }),
          run: async (_r: string, op: string, a: string) => {
            if (op === 'resolve') return a === 'refs/heads/feat' ? w.__v.head : oid('1');
            if (op === 'mergeBase') return oid('2');
            if (op === 'rawDiff') return raw();
            if (op === 'patchDiff') return patch();
            if (op === 'blob') return lines(N - 1, 'b').replace(/^\+/gm, '') + `\n${a === oid('3') ? 'x' : 'y'}\n`;
            return null;
          },
        },
      };
    }, N);
  }
  async function openBig(page: Page) {
    await page.goto('/');
    await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
    await page.getByTestId('open-btn').click();
    await expect(page.getByTestId('progress')).toHaveText('0 / 3');
  }

  test('starts collapsed and unread, says why, and opens on demand', async ({ page }) => {
    await fakeBig(page);
    await openBig(page);
    const big = row(page, 'big.sql');
    await expect(big).toHaveAttribute('data-state', 'unread');
    await expect(big.locator('.file-body')).toHaveCount(0);
    await expect(big.getByTestId('file-big')).toHaveText('Large diff, 2,501 lines');
    await expect(row(page, 's.ts').locator('.file-body')).toHaveCount(1);
    await big.getByTestId('file-expand').click();
    await expect(big.locator('.ln.add')).toHaveCount(N);
    await expect(big.getByTestId('file-big')).toHaveCount(0);
    await big.getByTestId('file-expand').click();
    await expect(big.locator('.file-body')).toHaveCount(0);
  });

  test('2,000 lines is not large yet', async ({ page }) => {
    await fakeBig(page);
    await openBig(page);
    const edge = row(page, 'edge.sql');
    await expect(edge.locator('.ln')).toHaveCount(2000);   // 머리 1 + 1999
    await expect(edge.getByTestId('file-big')).toHaveCount(0);
  });

  test('can be checked while collapsed, and the note goes away', async ({ page }) => {
    await fakeBig(page);
    await openBig(page);
    const big = row(page, 'big.sql');
    await big.getByTestId('file-check').check();
    await expect(page.getByTestId('progress')).toHaveText('1 / 3');
    await expect(big.getByTestId('file-big')).toHaveCount(0);
    await expect(big.locator('.file-body')).toHaveCount(0);
  });

  test('a large file changed since viewed opens on what changed, so the few lines are not missed', async ({ page }) => {
    await fakeBig(page);
    await openBig(page);
    const big = row(page, 'big.sql');
    await big.getByTestId('file-check').check();
    await expect(big).toHaveAttribute('data-state', 'viewed');
    await page.evaluate(() => { const v = (window as any).__v; v.head = 'e'.repeat(40); v.tail = 'y'; });
    await page.getByTestId('refresh-btn').click();
    await expect(big).toHaveAttribute('data-state', 'changed-since-viewed');
    await expect(big.getByTestId('since-diff').locator('.ln.add')).toHaveText(['+y']);
    await expect(big.getByTestId('since-diff').locator('.ln.del')).toHaveText(['-x']);
    await expect(big.getByTestId('file-big')).toHaveCount(0);
  });

  test('a new commit to an opened large file collapses it again, still not viewed', async ({ page }) => {
    await fakeBig(page);
    await openBig(page);
    const big = row(page, 'big.sql');
    await big.getByTestId('file-expand').click();
    await expect(big.locator('.ln.add')).toHaveCount(N);
    await page.evaluate(() => { const v = (window as any).__v; v.head = 'e'.repeat(40); v.tail = 'y'; });
    await page.getByTestId('refresh-btn').click();
    await expect(big.locator('.file-body')).toHaveCount(0);
    await expect(big).toHaveAttribute('data-state', 'unread');
  });
});
