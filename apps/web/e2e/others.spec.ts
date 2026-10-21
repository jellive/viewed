import { test, expect, type Page } from '@playwright/test';
import { mockGitHub, seedSettings } from './fixtures';

// 데스크톱 브리지를 흉내 낸다 — git 은 a.ts·b.ts 두 파일의 고정 diff, authors 는 테스트가 바꿀 수 있다
async function fakeLocal(page: Page, o: { extraMe?: string[]; authorsFail?: boolean; authorsHang?: boolean; authorsRaw?: string } = {}) {
  await page.addInitScript((o) => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device', ...(o.extraMe ? { extraMe: o.extraMe } : {}) }));
    const oid = (c: string) => c.repeat(40);
    const w = window as any;
    const raw = `:100644 100644 ${oid('a')} ${oid('b')} M\0src/a.ts\0:100644 100644 ${oid('c')} ${oid('d')} M\0src/b.ts\0`;
    const one = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n`;
    w.__git = { head: oid('f'), mb: oid('e'), raw, patch: one('src/a.ts') + one('src/b.ts') };
    w.__authors = { files: { 'src/a.ts': [['alice', 'a@example.test']], 'src/b.ts': [['bob', 'b@example.test']] }, renames: [] };
    w.__authorsFail = !!o.authorsFail; w.__authorsHang = !!o.authorsHang; w.__authorsRaw = o.authorsRaw;
    w.viewedDesktop = {
      getSecret: async () => null,
      setSecret: async () => {},
      git: {
        pick: async () => null,
        list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/main'], defaultBase: null, current: 'refs/heads/feat', remote: null, user: { name: 'alice', email: 'a@example.test' } }),
        run: async (_repo: string, op: string, ref: string) => {
          if (op === 'authors') { if (w.__authorsFail) throw new Error('boom'); if (w.__authorsHang) return new Promise(() => {}); return w.__authorsRaw ?? JSON.stringify(w.__authors); }
          return op === 'resolve' ? (ref === 'refs/heads/feat' ? w.__git.head : oid('d'))
            : op === 'mergeBase' ? w.__git.mb : op === 'rawDiff' ? w.__git.raw : op === 'patchDiff' ? w.__git.patch : null;
        },
      },
    };
  }, o);
}

async function openLocal(page: Page, progress: string, goto = true) {
  if (goto) await page.goto('/');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText(progress);
}
const row = (page: Page, path: string) => page.getByTestId('file-row').filter({ hasText: path });

test('others-only file is collapsed, counted viewed, and its checkbox is locked', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page, '1 / 2');
  const b = row(page, 'src/b.ts');
  await expect(b).toHaveAttribute('data-state', 'viewed');
  await expect(b).toHaveAttribute('data-others', '1');
  await expect(b.getByTestId('file-others')).toHaveText('bob');
  await expect(b.getByTestId('file-check')).toBeDisabled();
  await expect(b.getByTestId('file-check')).toBeChecked();
  await expect(b.locator('.file-body')).toHaveCount(0);
});

test('my file stays unread and expanded', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page, '1 / 2');
  const a = row(page, 'src/a.ts');
  await expect(a).toHaveAttribute('data-state', 'unread');
  await expect(a.locator('.file-body')).toHaveCount(1);
  await expect(a.getByTestId('file-others')).toHaveCount(0);
  await expect(a.getByTestId('file-check')).toBeEnabled();
});

test('authors failure shows everything as mine', async ({ page }) => {
  await fakeLocal(page, { authorsFail: true });
  await openLocal(page, '0 / 2');
  await expect(page.getByTestId('file-others')).toHaveCount(0);
});

test('extra names in settings make that author mine', async ({ page }) => {
  await fakeLocal(page);
  await page.goto('/');
  await page.getByTestId('settings-open').click();
  await page.getByTestId('extra-me').fill('bob\n\n  b@example.test  \n');
  await page.getByTestId('settings-save').click();
  await openLocal(page, '0 / 2', false);   // 다시 가면 init 스크립트가 설정을 되돌린다
  await expect(row(page, 'src/b.ts')).toHaveAttribute('data-state', 'unread');
  await expect(page.getByTestId('file-others')).toHaveCount(0);
  // 저장된 값은 한 줄에 하나로 돌아온다(빈 줄은 버려진다)
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('extra-me')).toHaveValue('bob\nb@example.test');
});

test('refresh after I touch an others file brings it back as unread', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page, '1 / 2');
  await expect(row(page, 'src/b.ts')).toHaveAttribute('data-state', 'viewed');
  await page.evaluate(() => { (window as any).__authors.files['src/b.ts'].push(['alice', 'a@example.test']); });
  await page.getByTestId('refresh-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await expect(row(page, 'src/b.ts')).toHaveAttribute('data-state', 'unread');
  await expect(page.getByTestId('file-others')).toHaveCount(0);
});

test('GitHub mode shows no others badge', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' }] });
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 1');
  await expect(page.getByTestId('file-others')).toHaveCount(0);
  await expect(page.locator('[data-others]')).toHaveCount(0);
});

test('authors that never answer do not hold the list back', async ({ page }) => {
  await fakeLocal(page, { authorsHang: true });
  await page.goto('/');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2', { timeout: 3500 });
  await expect(page.getByTestId('file-others')).toHaveCount(0);
});

test('malformed authors drop the others map instead of failing the load', async ({ page }) => {
  await fakeLocal(page, { authorsRaw: '{"files":{"src/b.ts":null},"renames":[]}' });
  await openLocal(page, '0 / 2');
  await expect(page.getByTestId('file-others')).toHaveCount(0);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('adding my name in settings while a review is open re-evaluates it without refresh', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page, '1 / 2');
  await expect(row(page, 'src/b.ts')).toHaveAttribute('data-state', 'viewed');
  await page.getByTestId('settings-open').click();
  await page.getByTestId('extra-me').fill('bob');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await expect(row(page, 'src/b.ts')).toHaveAttribute('data-state', 'unread');
});

// ---- 펼친 diff 의 남의 줄 바탕 ----
// blameAuthors 모의: 줄마다 [이름, 이메일] | null. a.ts 는 3줄 diff(ctx, +new, +added)로 바꿔 둔다
type BlameOpts = { blame?: (string[] | null)[]; fail?: boolean; delay?: number };
async function fakeBlame(page: Page, o: BlameOpts = {}) {
  await page.addInitScript((o) => {
    const w = window as any;
    w.__blameCalls = [] as string[]; w.__inflight = 0; w.__maxInflight = 0;
    const git = w.viewedDesktop.git, run = git.run;
    const one = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+added\n`;
    if (w.__git.patch.includes('src/a.ts')) w.__git.patch = one('src/a.ts') + 'diff --git a/src/b.ts' + w.__git.patch.split('diff --git a/src/b.ts')[1];
    git.run = async (repo: string, op: string, ...a: string[]) => {
      if (op !== 'blameAuthors') return run(repo, op, ...a);
      w.__blameCalls.push(a[1]);
      w.__inflight++; w.__maxInflight = Math.max(w.__maxInflight, w.__inflight);
      try {
        await new Promise((r) => setTimeout(r, o.delay ?? 0));
        if (o.fail) throw new Error('boom');
        return JSON.stringify(o.blame ?? []);
      } finally { w.__inflight--; }
    };
  }, o);
}
const A = ['alice', 'a@example.test'], B = ['bob', 'b@example.test'];
const lnOf = (page: Page, n: number) => page.getByTestId('file-row').filter({ hasText: 'src/a.ts' }).locator(`.ln.add[data-n="${n}"]`);

test("other people's added lines get the tint, mine do not", async ({ page }) => {
  await fakeLocal(page); await fakeBlame(page, { blame: [A, B, A] });
  await openLocal(page, '1 / 2');
  await expect(lnOf(page, 2)).toHaveClass(/\bother\b/);
  await expect(lnOf(page, 3)).not.toHaveClass(/\bother\b/);
  await expect(lnOf(page, 2)).toHaveCSS('opacity', '1');
  // 문맥 줄에는 안 붙는다
  await expect(page.locator('.ln.ctx.other, .ln.del.other')).toHaveCount(0);
});

test('blame failure leaves lines untinted', async ({ page }) => {
  await fakeLocal(page); await fakeBlame(page, { fail: true });
  await openLocal(page, '1 / 2');
  await expect.poll(() => page.evaluate(() => (window as any).__blameCalls.length)).toBeGreaterThan(0);
  await expect(page.locator('.other')).toHaveCount(0);
});

test('collapsed files are not blamed and at most 4 blames run at once', async ({ page }) => {
  await fakeLocal(page);
  await page.addInitScript(() => {
    const w = window as any, oid = (c: string) => c.repeat(40);
    const mine = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts`);
    w.__git.raw = [...mine, 'src/o.ts'].map((p, i) => `:100644 100644 ${oid('a')} ${(i + 16).toString(16).repeat(20)} M\0${p}\0`).join('');
    w.__git.patch = [...mine, 'src/o.ts'].map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n`).join('');
    w.__authors = { files: { ...Object.fromEntries(mine.map((p) => [p, [['alice', 'a@example.test']]])), 'src/o.ts': [['bob', 'b@example.test']] }, renames: [] };
  });
  await fakeBlame(page, { blame: [A, B], delay: 80 });
  await openLocal(page, '1 / 13');
  await expect.poll(() => page.evaluate(() => (window as any).__blameCalls.length), { timeout: 8000 }).toBe(12);
  const r = await page.evaluate(() => ({ max: (window as any).__maxInflight, calls: (window as any).__blameCalls as string[] }));
  expect(r.max).toBeLessThanOrEqual(4);
  expect(r.max).toBeGreaterThan(1);
  expect(r.calls).not.toContain('src/o.ts');
});

test('since view tints the same head lines', async ({ page }) => {
  await fakeLocal(page); await fakeBlame(page, { blame: [A, B, A, B] });
  await page.addInitScript(() => {
    const w = window as any, g = w.viewedDesktop.git, run = g.run;
    g.run = async (repo: string, op: string, ...a: string[]) => op === 'blob' ? (a[0] === 'b'.repeat(40) ? 'ctx\nnew\n' : 'ctx\nnew\nadded\nmore\n') : run(repo, op, ...a);
  });
  await openLocal(page, '1 / 2');
  const a = row(page, 'src/a.ts');
  await a.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('2 / 2');
  // 그 뒤 a.ts 가 바뀐다 — 새 blob, 줄 하나 더
  await page.evaluate(() => {
    const w = window as any, oid = (c: string) => c.repeat(40);
    w.__git.raw = w.__git.raw.replace(oid('b'), oid('9'));
    w.__git.patch = w.__git.patch.replace('@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+added\n', '@@ -1,2 +1,4 @@\n ctx\n-old\n+new\n+added\n+more\n');
  });
  await page.getByTestId('refresh-btn').click();
  await expect(a).toHaveAttribute('data-state', 'changed-since-viewed');
  const since = a.getByTestId('since-diff');
  await expect(since.locator('.ln.add[data-n="4"]')).toHaveClass(/\bother\b/);
  await expect(since.locator('.ln.add[data-n="3"]')).not.toHaveClass(/\bother\b/);
});
