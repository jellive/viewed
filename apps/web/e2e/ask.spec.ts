import { test, expect, type Page } from '@playwright/test';
import { mockGitHub } from './fixtures';

// 시각 표시(MM-DD HH:mm)는 화면의 시간대를 따른다 — 고정한다
test.use({ timezoneId: 'Asia/Seoul' });

const oid = (c: string) => c.repeat(40);
const HEAD = oid('f'), MB = oid('e');

// 데스크톱 브리지를 흉내 낸다(recent.spec.ts 의 fakeDesktop 모양) — git 은 고정 diff 하나, ask 는 요청을 쌓고 테스트가 답을 낸다
async function fakeLocal(page: Page, o: { rename?: boolean; accounts?: boolean; noMergeBase?: boolean } = {}) {
  await page.addInitScript((o) => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: o.accounts ? [{ label: 'personal', token: '' }] : [], gistAccount: '', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const oid = (c: string) => c.repeat(40);
    const w = window as any;
    w.__asks = []; w.__cancelled = []; w.__progress = [];
    const waiting: Record<string, (r: unknown) => void> = {};
    // 답을 낸다 — id 를 안 주면 가장 최근 질문
    w.__answer = (r: unknown, id?: string) => { const k = id ?? w.__asks[w.__asks.length - 1].id; waiting[k]?.(r); delete waiting[k]; };
    w.__stage = (stage: string, id?: string) => { const k = id ?? w.__asks[w.__asks.length - 1].id; for (const cb of w.__progress) cb({ id: k, stage }); };
    const raw = o.rename
      ? `:100644 100644 ${oid('a')} ${oid('b')} R100\0src/old.ts\0src/a.ts\0`
      : `:100644 100644 ${oid('a')} ${oid('b')} M\0src/a.ts\0`;
    const feat = oid('f');
    const head = o.rename ? 'diff --git a/src/old.ts b/src/a.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/a.ts\n' : 'diff --git a/src/a.ts b/src/a.ts\n';
    const patch = `${head}--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n`;
    // 테스트가 바꿀 수 있는 저장소 상태 — 새 커밋·리베이스를 흉내 낸다
    w.__git = { head: feat, mb: oid('e'), raw, patch, blobs: {} as Record<string, string> };
    w.viewedDesktop = {
      getSecret: async (n: string) => (n === 'token:personal' ? 'tok' : null),
      setSecret: async () => {},
      git: {
        pick: async () => null,
        list: async () => ['/r/a'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/main'], defaultBase: null, current: 'refs/heads/feat', remote: null }),
        run: async (_repo: string, op: string, ref: string) => op === 'resolve' ? (ref === 'refs/heads/feat' ? w.__git.head : oid('d'))
          : op === 'mergeBase' ? (o.noMergeBase ? null : w.__git.mb) : op === 'rawDiff' ? w.__git.raw : op === 'patchDiff' ? w.__git.patch
          : op === 'blob' ? (w.__git.blobs[ref] ?? null) : null,
      },
      ask: {
        start: (req: { id: string }) => new Promise((res) => { w.__asks.push(req); waiting[req.id] = res; }),
        cancel: async (id: string) => { w.__cancelled.push(id); },
        onProgress: (cb: (p: unknown) => void) => { w.__progress.push(cb); return () => { w.__progress = w.__progress.filter((x: unknown) => x !== cb); }; },
      },
    };
  }, o);
}

async function openLocal(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 1');
}

// 저장소를 바꾼다(새 head·merge-base·diff·blob) — 다시 읽기 버튼을 눌러야 화면에 오른다
const moveRepo = (page: Page, g: { head?: string; mb?: string; raw?: string; patch?: string; blobs?: Record<string, string> }) =>
  page.evaluate((g) => { Object.assign((window as any).__git, g); }, g);
const refresh = (page: Page) => page.getByTestId('refresh-btn').click();

const line = (page: Page, kind: string, text: string) => page.locator(`.ln.${kind}`).filter({ hasText: text });
async function ask(page: Page, kind: string, text: string, q: string) {
  const ln = line(page, kind, text);
  await ln.hover();
  await ln.getByTestId('ask-btn').click();
  await expect(page.getByTestId('thread-input')).toBeFocused();
  await page.getByTestId('thread-input').fill(q);
  await page.getByTestId('thread-send').click();
}
const asks = (page: Page) => page.evaluate(() => (window as any).__asks);
const answer = (page: Page, r: unknown, id?: string) => page.evaluate(([r, id]) => (window as any).__answer(r, id), [r, id] as const);
const ok = (text: string, source: unknown = { kind: 'none', reason: 'not-found' }, account: string | null = 'you@example.com') => ({ ok: true, answer: text, source, account });

test('a + on a local review asks that line and shows the answer under it with source and account', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await expect(line(page, 'ctx', 'ctx').getByTestId('ask-btn')).toHaveAttribute('aria-label', 'Ask about this line');
  await ask(page, 'add', 'new', 'why?');
  const [req] = await asks(page);
  expect(req).toMatchObject({ repo: '/r/a', head: HEAD, mergeBase: MB, side: 'R', line: 2, lineText: 'new', path: 'src/a.ts', question: 'why?', history: [], lang: 'en' });
  expect(typeof req.id).toBe('string');
  await answer(page, ok('Because of the review.', { kind: 'session', sessionId: 'e5f37e58-1111-2222', at: Date.UTC(2026, 9, 15, 5, 14), subagent: false }));
  // 스레드는 그 줄 바로 다음 자리
  const thread = page.locator('.ln.add + [data-testid="thread"]');
  await expect(thread.getByTestId('thread-answer')).toHaveText('Because of the review.');
  await expect(thread.getByTestId('thread-source')).toHaveText('From the session log · e5f37e58 · 10-15 14:14');
  await expect(thread.getByTestId('thread-account')).toHaveText('Asked as you@example.com');
  await expect(thread).toContainText('why?');
  // 진행 표시가 사라져도 답이 온 것을 화면 낭독기에 알린다
  await expect(thread.getByTestId('thread-live')).toHaveText('Answer arrived.');
  await expect(thread.getByTestId('thread-live')).toHaveAttribute('aria-live', 'polite');
});

test('a deleted line of a renamed file asks the merge-base side with the previous path', async ({ page }) => {
  await fakeLocal(page, { rename: true });
  await openLocal(page);
  await ask(page, 'del', 'old', 'gone?');
  const [req] = await asks(page);
  expect(req).toMatchObject({ head: HEAD, mergeBase: MB, side: 'L', line: 2, lineText: 'old', path: 'src/a.ts', previousPath: 'src/old.ts' });
  await answer(page, ok('x', { kind: 'none', reason: 'not-found' }, null));
  await expect(page.getByTestId('thread-source')).toHaveText('No session log · from commits and code');
  await expect(page.getByTestId('thread-account')).toHaveText("Couldn't read the account");
});

test('a follow-up stacks in the same thread and sends at most three earlier exchanges', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'q1');
  await answer(page, ok('a1'));
  for (const n of [2, 3, 4, 5]) {
    await expect(page.getByTestId('thread-answer')).toHaveCount(n - 1);
    await page.getByTestId('thread-input').fill(`q${n}`);
    await page.getByTestId('thread-input').press('Enter');
    await answer(page, ok(`a${n}`));
  }
  await expect(page.getByTestId('thread')).toHaveCount(1);
  await expect(page.getByTestId('thread-answer')).toHaveText(['a1', 'a2', 'a3', 'a4', 'a5']);
  const all = await asks(page);
  expect(all[1].history).toEqual([{ q: 'q1', a: 'a1' }]);
  expect(all[4].history).toEqual([{ q: 'q2', a: 'a2' }, { q: 'q3', a: 'a3' }, { q: 'q4', a: 'a4' }]);
});

test('progress shows waiting, searching and answering in turn', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'why?');
  const p = page.getByTestId('thread').locator('.thread-progress');
  await expect(p).toContainText('Waiting…');
  await expect(page.getByTestId('thread-cancel')).toBeVisible();
  await page.evaluate(() => (window as any).__stage('searching'));
  await expect(p).toContainText('Finding the session log…');
  await page.evaluate(() => (window as any).__stage('answering'));
  await expect(p).toContainText('Claude is answering…');
  await answer(page, ok('done'));
  await expect(p).toHaveCount(0);
  await expect(page.getByTestId('thread-cancel')).toHaveCount(0);
});

test('Esc in an empty input closes the thread, and a second + on the same line focuses the existing one', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  const ln = line(page, 'add', 'new');
  await ln.hover();
  await ln.getByTestId('ask-btn').click();
  await page.getByTestId('thread-input').fill('draft');
  await page.getByTestId('thread-input').press('Escape');   // 글이 있으면 안 닫는다
  await expect(page.getByTestId('thread')).toHaveCount(1);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await ln.hover();
  await ln.getByTestId('ask-btn').click();
  await expect(page.getByTestId('thread')).toHaveCount(1);
  await expect(page.getByTestId('thread-input')).toBeFocused();
  await page.getByTestId('thread-input').fill('');
  await page.getByTestId('thread-input').press('Escape');
  await expect(page.getByTestId('thread')).toHaveCount(0);
  await expect(ln.getByTestId('ask-btn')).toBeFocused();   // 닫으면 그 줄의 + 로 돌아간다
});

test('cancel removes the progress and a late answer is dropped', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'why?');
  const [req] = await asks(page);
  await page.getByTestId('thread-cancel').click();
  expect(await page.evaluate(() => (window as any).__cancelled)).toEqual([req.id]);
  await expect(page.getByTestId('thread').locator('.thread-progress')).toHaveCount(0);
  await answer(page, ok('late'), req.id);
  await page.waitForTimeout(200);
  await expect(page.getByTestId('thread-answer')).toHaveCount(0);
  await expect(page.getByTestId('thread-input')).toBeEnabled();
});

// 파일 이름 검색은 이 브랜치에 없다(feat/file-search) — 접기와 확인한 파일 숨기기만
test('folding the file, searching or filtering keeps the thread', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'why?');
  await answer(page, ok('kept'));
  await page.getByTestId('file-expand').click();
  await expect(page.getByTestId('thread')).toHaveCount(0);
  await page.getByTestId('file-expand').click();
  await expect(page.getByTestId('thread-answer')).toHaveText('kept');
  await page.getByTestId('file-check').check();   // 확인하면 접히고, 필터를 켜면 사라진다
  await page.getByTestId('filter-unviewed').check();
  await expect(page.getByTestId('file-row')).toHaveCount(0);
  await page.getByTestId('filter-unviewed').uncheck();
  await page.getByTestId('file-check').uncheck();
  await expect(page.getByTestId('thread-answer')).toHaveText('kept');
});

test('a GitHub review has no +, also after switching the source button without reopening', async ({ page }) => {
  await fakeLocal(page, { accounts: true });
  await mockGitHub(page, { files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' }] });
  await page.goto('/');
  await page.getByTestId('source-github').click();
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 1');
  await expect(page.locator('.ln.add')).toHaveCount(1);
  await expect(page.getByTestId('ask-btn')).toHaveCount(0);
  await page.getByTestId('source-local').click();   // 버튼만 바꿨다 — 화면은 여전히 GitHub 리뷰
  await expect(page.getByTestId('progress')).toHaveText('0 / 1');
  await expect(page.getByTestId('ask-btn')).toHaveCount(0);
  await page.getByTestId('open-btn').click();   // 로컬로 열면 + 가 생기고, 버튼만 GitHub 로 바꿔도 남는다
  await expect(page.locator('.ln.add').getByTestId('ask-btn')).toHaveCount(1);
  await page.getByTestId('source-github').click();
  await expect(page.locator('.ln.add').getByTestId('ask-btn')).toHaveCount(1);
});

test('answers are plain text: tags stay literal and backticks become code', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'why?');
  await answer(page, ok('<b>bold</b> <a href="https://example.com">x</a> calls `raw.pop()` here'));
  const a = page.getByTestId('thread-answer');
  await expect(a).toHaveText('<b>bold</b> <a href="https://example.com">x</a> calls raw.pop() here');
  await expect(a.locator('b, a')).toHaveCount(0);
  await expect(a.locator('code')).toHaveText('raw.pop()');
});

test('an error result shows its message and a retry', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'why?');
  // 아는 사유는 앱 언어 문구로(데스크톱 문구는 한국어 고정이다)
  await answer(page, { ok: false, error: 'login', message: '로그인 필요' });
  await expect(page.getByTestId('thread-error')).toContainText('Claude Code is not logged in.');
  await expect(page.getByTestId('thread-error')).not.toContainText('로그인 필요');
  await expect(page.getByTestId('thread-live')).toHaveText('Claude Code is not logged in.');
  await expect(page.getByTestId('thread-error')).not.toHaveAttribute('role', 'alert');   // 알림 자리 하나만 읽는다 — 두 번 읽히지 않게
  await page.getByTestId('thread-error').getByRole('button').click();
  await expect(page.getByTestId('thread-error')).toHaveCount(0);
  const all = await asks(page);
  expect(all).toHaveLength(2);
  expect(all[1]).toMatchObject({ question: 'why?', history: [] });
  expect(all[1].id).not.toBe(all[0].id);
  await answer(page, ok('fine now'));
  await expect(page.getByTestId('thread-answer')).toHaveText('fine now');
});

test('a failed result is shown in the app language, not the desktop message', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'why?');
  await answer(page, { ok: false, error: 'failed', message: '답을 못 받았어요. 다시 시도해 주세요' });
  await expect(page.getByTestId('thread-error')).toContainText("Couldn't get an answer.");
  await expect(page.getByTestId('thread-error')).not.toContainText('답을');
});

test('a session answer written by a subagent says so in its source', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'why?');
  await answer(page, ok('sub', { kind: 'session', sessionId: 'e5f37e58-1111-2222', at: Date.UTC(2026, 9, 15, 5, 14), subagent: true }));
  await expect(page.getByTestId('thread-source')).toHaveText('From the session log · e5f37e58 (subagent) · 10-15 14:14');
});

test('two questions at once: the second thread shows that it is waiting', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'first?');
  const ctx = line(page, 'ctx', 'ctx');
  await ctx.hover();
  await ctx.getByTestId('ask-btn').click();
  const input = page.locator('.ln.ctx + [data-testid="thread"]').getByTestId('thread-input');
  await expect(input).toBeFocused();
  await input.fill('second?');
  await input.press('Enter');
  await expect.poll(async () => (await asks(page)).length).toBe(2);
  const [a, b] = await asks(page);
  await page.evaluate(([a, b]) => { (window as any).__stage('queued', a); (window as any).__stage('queued', b); (window as any).__stage('searching', a); }, [a.id, b.id] as const);
  const first = page.locator('.ln.add + [data-testid="thread"]');
  const second = page.locator('.ln.ctx + [data-testid="thread"]');
  await expect(first.locator('.thread-progress')).toContainText('Finding the session log…');
  await expect(second.locator('.thread-progress')).toContainText('Waiting…');
  await expect(second.getByTestId('thread-live')).toHaveText('Waiting…');
  await answer(page, ok('one'), a.id);
  await page.evaluate((b) => (window as any).__stage('searching', b), b.id);
  await expect(second.locator('.thread-progress')).toContainText('Finding the session log…');
});

test('without a merge base, deleted lines have no +', async ({ page }) => {
  await fakeLocal(page, { noMergeBase: true });
  await openLocal(page);
  await expect(page.locator('.ln.del')).toHaveCount(1);
  await expect(page.locator('.ln.del').getByTestId('ask-btn')).toHaveCount(0);
  await expect(page.locator('.ln.add').getByTestId('ask-btn')).toHaveCount(1);
});

test.describe('on a phone-sized touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  // iOS 는 16px 보다 작은 입력칸에 포커스하면 화면을 확대한다
  test('the thread input is at least 16px', async ({ page }) => {
    await fakeLocal(page);
    await openLocal(page);
    await line(page, 'add', 'new').getByTestId('ask-btn').click();
    const size = await page.getByTestId('thread-input').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  });
});

const RAW2 = `:100644 100644 ${oid('a')} ${oid('c')} M\0src/a.ts\0`;
const HEAD2 = oid('9'), MB2 = oid('8');
const diffOf = (body: string) => `diff --git a/src/a.ts b/src/a.ts\n--- a/x\n+++ b/x\n${body}`;

test.describe('since-viewed views', () => {
  async function viewThenMove(page: Page, g: Parameters<typeof moveRepo>[1]) {
    await fakeLocal(page);
    await openLocal(page);
    await page.getByTestId('file-check').check();
    await expect(page.getByTestId('progress')).toHaveText('1 / 1');
    await moveRepo(page, g);
    await refresh(page);
    await expect(page.getByTestId('file-row')).toHaveAttribute('data-state', 'changed-since-viewed');
    if (!(await page.getByTestId('since-diff').isVisible())) await page.getByTestId('file-expand').click();
    await expect(page.getByTestId('since-diff')).toBeVisible();
  }

  test('in the since-viewed blob view added lines have a + and deleted lines do not', async ({ page }) => {
    // 확인한 blob(b) → 지금 blob(c). merge-base 는 그대로라 blob 비교 경로다
    await viewThenMove(page, {
      head: HEAD2, raw: RAW2,
      patch: diffOf('@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+extra\n'),
      blobs: { [oid('b')]: 'ctx\nold\nz\n', [oid('c')]: 'ctx\nnew\nextra\nz\n' },
    });
    const sd = page.getByTestId('since-diff');
    await expect(sd.locator('.ln.del')).toHaveCount(1);
    await expect(sd.locator('.ln.del').getByTestId('ask-btn')).toHaveCount(0);
    await expect(sd.locator('.ln.add').getByTestId('ask-btn')).toHaveCount(2);
    await sd.locator('.ln.add').filter({ hasText: 'extra' }).hover();
    await sd.locator('.ln.add').filter({ hasText: 'extra' }).getByTestId('ask-btn').click();
    await page.getByTestId('thread-input').fill('why extra?');
    await page.getByTestId('thread-send').click();
    const [req] = await asks(page);
    expect(req).toMatchObject({ head: HEAD2, mergeBase: MB, side: 'R', line: 3, lineText: 'extra', path: 'src/a.ts' });
  });

  test('the since-viewed block view asks with full-diff coordinates', async ({ page }) => {
    // merge-base 가 움직였다 → 지금 patch 에서 확인 안 한 블록이 든 덩어리를 그대로 보인다(전체 diff 좌표)
    await viewThenMove(page, {
      head: HEAD2, mb: MB2, raw: RAW2,
      patch: diffOf('@@ -1,4 +1,5 @@\n ctx\n-old\n+new\n mid\n+extra\n tail\n'),
    });
    await expect(page.getByTestId('since-blocks')).toBeVisible();
    const sd = page.getByTestId('since-diff');
    await sd.locator('.ln.add').filter({ hasText: 'extra' }).getByTestId('ask-btn').click();
    await page.getByTestId('thread-input').fill('q-add');
    await page.getByTestId('thread-send').click();
    // 삭제 줄은 merge-base 쪽 옛 번호(2)
    await sd.locator('.ln.del').filter({ hasText: 'old' }).getByTestId('ask-btn').click();
    await page.getByTestId('thread-input').first().fill('q-del');
    await page.getByTestId('thread-send').first().click();
    const [a, b] = await asks(page);
    expect(a).toMatchObject({ head: HEAD2, mergeBase: MB2, side: 'R', line: 4, lineText: 'extra' });
    expect(b).toMatchObject({ head: HEAD2, mergeBase: MB2, side: 'L', line: 2, lineText: 'old', path: 'src/a.ts' });
  });
});

test('a new head cancels the running question and clears the threads', async ({ page }) => {
  await fakeLocal(page);
  await openLocal(page);
  await ask(page, 'add', 'new', 'why?');
  const [req] = await asks(page);
  await expect(page.getByTestId('thread')).toHaveCount(1);
  await moveRepo(page, { head: HEAD2, raw: RAW2, patch: diffOf('@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n') });
  await refresh(page);
  await expect(page.getByTestId('thread')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__cancelled)).toEqual([req.id]);
  // 늦게 온 답은 새 화면에 나타나지 않는다
  await answer(page, ok('stale'), req.id);
  await page.waitForTimeout(200);
  await expect(page.getByTestId('thread-answer')).toHaveCount(0);
});
