import { test, expect, type Page } from '@playwright/test';
import { mockGitHub, seedSettings, SETTINGS } from './fixtures';

const files = [
  { filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' },
  { filename: 'logo.png', status: 'added', sha: 'p1' },
];

// GitHub 모드는 칸만 채운다 — 폰에서 토큰이 만료됐으면 켜자마자 오류가 나므로 자동으로 열지 않는다
test('the GitHub fields come back as last opened, and nothing opens by itself', async ({ page }) => {
  await page.addInitScript((s) => localStorage.setItem('viewed.settings', JSON.stringify(s)),
    { ...SETTINGS, accounts: [{ label: 'personal', token: 'tok' }, { label: 'work', token: 'tok2' }] });
  await mockGitHub(page, { files });
  const compares: string[] = [], auth: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/compare/')) { compares.push(r.url()); auth.push(r.headers()['authorization'] ?? ''); } });
  await page.goto('/');
  await page.getByTestId('account-select').selectOption('work');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await page.getByTestId('branch-input').fill('other');   // 열지 않은 입력은 기억하지 않는다
  await page.reload();
  await expect(page.getByTestId('account-select')).toHaveValue('work');
  await expect(page.getByTestId('repo-input')).toHaveValue('acme/widget');
  await expect(page.getByTestId('branch-input')).toHaveValue('feat');
  await expect(page.getByTestId('base-input')).toHaveValue('');   // 빈 base 는 빈 채로 — 매번 기본 브랜치
  await page.waitForTimeout(500);
  await expect(page.getByTestId('file-row')).toHaveCount(0);
  expect(compares).toHaveLength(1);
  await page.getByTestId('open-btn').click();   // 칸만이 아니라 요청도 기억한 계정(work)의 토큰으로
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  expect(auth).toEqual(['Bearer tok2', 'Bearer tok2']);
});

test('a remembered GitHub account that is gone opens with the first account', async ({ page }) => {
  await seedSettings(page);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify(
    { last: { source: 'github', account: 'ghost', repo: 'acme/widget', branch: 'feat', base: '' }, local: {} })));
  await mockGitHub(page, { files });
  const auth: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/compare/')) auth.push(r.headers()['authorization'] ?? ''); });
  await page.goto('/');
  await expect(page.getByTestId('repo-input')).toHaveValue('acme/widget');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  expect(auth).toEqual(['Bearer tok']);
});

test('on the desktop the source last opened comes back', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [{ label: 'personal', token: '' }], gistAccount: 'personal', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    (window as any).viewedDesktop = {
      getSecret: async (n: string) => (n === 'token:personal' ? 'tok' : null),
      setSecret: async () => {},
      git: { pick: async () => null, list: async () => [], info: async () => { throw new Error('none'); }, run: async () => null },
    };
  });
  await mockGitHub(page, { files });
  await page.goto('/');
  await expect(page.getByTestId('source-local')).toHaveAttribute('aria-pressed', 'true');   // 기록이 없으면 로컬 폴더
  await page.getByTestId('source-github').click();
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await page.reload();
  await expect(page.getByTestId('source-github')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('repo-input')).toHaveValue('acme/widget');
});

// 웹 e2e 에도 데스크톱 브리지를 흉내 내 넣을 수 있다 — 실제 git 없이 로컬 폴더 흐름을 UI 로 그대로 잰다
async function fakeDesktop(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [{ label: 'personal', token: '' }], gistAccount: 'personal', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const oid = (c: string) => c.repeat(40);
    (window as any).viewedDesktop = {
      getSecret: async (n: string) => (n === 'token:personal' ? 'tok' : null),
      setSecret: async () => {},
      git: {
        pick: async () => null,
        list: async () => ['/r/a', '/r/b'],
        info: async () => ({ refs: ['refs/heads/feat', 'refs/heads/main'], defaultBase: null, current: 'refs/heads/feat', remote: null }),
        // 바뀐 파일 없는 브랜치 — 열기가 성공해 기록되기만 하면 된다
        run: async (_repo: string, op: string, ref: string) => (op === 'resolve' ? oid(ref === 'refs/heads/feat' ? 'f' : 'e') : op === 'mergeBase' ? oid('e') : ''),
      },
    };
  });
}

test('after opening a GitHub review, going back to local folders picks the repo last opened there', async ({ page }) => {
  await fakeDesktop(page);
  await mockGitHub(page, { files });
  await page.goto('/');
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/a');
  await page.getByTestId('local-repo-select').selectOption('/r/b');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 0');
  await page.getByTestId('source-github').click();
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await page.getByTestId('source-local').click();
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/b');
  await page.reload();   // 다시 켜도 — 마지막 소스는 GitHub 라 자동으로 열지는 않는다
  await page.getByTestId('source-local').click();
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/b');
  await expect(page.getByTestId('file-row')).toHaveCount(0);
});

// localRepo 필드 전에 쓴 기록 — 마지막이 로컬이면 그 레포부터, 자동 열기도 그대로
test('a record written before the last local repo was kept still starts from the last local review', async ({ page }) => {
  await fakeDesktop(page);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify(
    { last: { source: 'local', repo: '/r/b', branch: 'refs/heads/feat', base: 'refs/heads/main' }, local: { '/r/b': { branch: 'refs/heads/feat', base: 'refs/heads/main' } } })));
  await page.goto('/');
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/b');
  await expect(page.getByTestId('progress')).toHaveText('0 / 0');
});

// 늦게 끝난 앞선 열기는 화면에도 기록에도 안 오른다 — 마지막에 연 것이 남는다
test('an earlier slower open that finishes last is not the one remembered', async ({ page }) => {
  await seedSettings(page);
  let gistGets = 0;
  await page.route('https://api.github.com/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const m = p.match(/^\/repos\/acme\/widget\/branches\/(slow|fast)$/);
    if (p === '/repos/acme/widget') return json({ default_branch: 'main' });
    if (m) { if (m[1] === 'slow') await new Promise((r) => setTimeout(r, 1500)); return json({ commit: { sha: m[1] } }); }
    const c = p.match(/^\/repos\/acme\/widget\/compare\/main\.\.\.(slow|fast)$/);
    if (c) return json({ files: [{ filename: `${c[1]}.ts`, status: 'added', sha: c[1], patch: '@@ -0,0 +1 @@\n+a' }] });
    const t = p.match(/^\/repos\/acme\/widget\/git\/trees\/(slow|fast)$/);
    if (t) return json({ truncated: false, tree: [{ path: `${t[1]}.ts`, type: 'blob', mode: '100644' }] });
    if (p === '/gists/g1') { gistGets++; return json({ files: {} }); }
    return route.fulfill({ status: 500, body: '{}' });
  });
  await page.goto('/');
  for (const branch of ['slow', 'fast']) {
    await page.getByTestId('repo-input').fill('acme/widget');
    await page.getByTestId('branch-input').fill(branch);
    await page.getByTestId('open-btn').click();
  }
  await expect(page.getByTestId('file-row')).toContainText('fast.ts');
  await expect.poll(() => gistGets, { timeout: 5000 }).toBe(2);   // slow 도 끝까지 왔다
  await page.waitForTimeout(300);
  await expect(page.getByTestId('file-row')).toContainText('fast.ts');
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('viewed.recent') ?? '{}'));
  expect(recent.last).toMatchObject({ source: 'github', branch: 'fast' });
});

// 다시 읽기는 같은 리뷰를 새로 볼 뿐 — 마지막으로 연 것을 다시 쓰지 않는다
test('a manual refresh never writes the remembered review', async ({ page }) => {
  await seedSettings(page);
  await page.addInitScript(() => {
    const w = window as unknown as { recentWrites: number };
    w.recentWrites = 0;
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === 'viewed.recent') w.recentWrites++;
      return orig.call(this, k, v);
    };
  });
  await mockGitHub(page, { files });
  const writes = () => page.evaluate(() => (window as unknown as { recentWrites: number }).recentWrites);
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  expect(await writes()).toBe(1);   // 연 것은 한 번 기록
  // 기록은 화면에 올릴 때 같이 일어난다 — '0 / 3' 이 보이면 이 다시 읽기가 기록했을 자리는 이미 지났다
  await mockGitHub(page, { head: 'h2', files: [...files, { filename: 'c.ts', status: 'added', sha: 'c1', patch: '@@ -0,0 +1 @@\n+c' }] });
  await page.getByTestId('refresh-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 3');
  expect(await writes()).toBe(1);
});

const history = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('viewed.recent') ?? '{}').history);
const at = (repo: string, branch = 'refs/heads/feat', base = 'refs/heads/main') => ({ repo, branch, base });
async function openRepo(page: Page, repo: string) {
  await page.getByTestId('local-repo-select').selectOption(repo);
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 0');
}

// 최근 목록은 연 조합을 최근 것부터 한 번씩 쌓는다 — 그 기록 전에 쓴 기록(레포별 마지막 조합, 마지막 것 먼저)에서 시작한다
test('a local open goes first in the history once, and the history starts from the record kept before it', async ({ page }) => {
  await fakeDesktop(page);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify({
    // 마지막 브랜치는 없다 — 켤 때 자동으로 열리지 않는다
    last: { source: 'local', repo: '/r/b', branch: 'refs/heads/gone', base: 'refs/heads/main' },
    local: { '/r/c': { branch: 'refs/heads/feat', base: 'refs/heads/main' }, '/r/b': { branch: 'refs/heads/gone', base: 'refs/heads/main' } },
  })));
  await page.goto('/');
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/b');
  await openRepo(page, '/r/a');
  await expect.poll(() => history(page)).toEqual([at('/r/a'), at('/r/b', 'refs/heads/gone'), at('/r/c')]);
  await openRepo(page, '/r/b');
  await openRepo(page, '/r/a');
  await expect.poll(() => history(page)).toEqual([at('/r/a'), at('/r/b'), at('/r/b', 'refs/heads/gone'), at('/r/c')]);
});

// 깨진 항목은 빼고, 겹치면 앞의 것 하나만, 10개까지
test('the history keeps well-formed entries once each, at most ten', async ({ page }) => {
  await fakeDesktop(page);
  await page.addInitScript(() => {
    const e = (i: number) => ({ repo: '/r/x', branch: `refs/heads/f${i}`, base: 'refs/heads/main' });
    localStorage.setItem('viewed.recent', JSON.stringify({ local: {}, history: [
      e(0), 1, null, 'x', { repo: '/r/x', branch: 'refs/heads/f1' }, { repo: 2, branch: 'refs/heads/f1', base: 'refs/heads/main' }, e(0),
      ...Array.from({ length: 12 }, (_, i) => e(i + 1))] }));
  });
  await page.goto('/');
  await openRepo(page, '/r/a');
  await expect.poll(() => history(page)).toEqual([at('/r/a'), ...Array.from({ length: 9 }, (_, i) => at('/r/x', `refs/heads/f${i}`))]);
});

// info 는 테스트가 손으로 푼다 — 응답 순서를 시간이 아니라 테스트가 정한다. runs: 열기가 부른 git 의 레포, gates: 레포별로 git 을 멈춰 둘 Promise
async function heldDesktop(page: Page, repos: string[]) {
  await page.addInitScript((repos) => {
    localStorage.setItem('viewed.settings', JSON.stringify({ accounts: [{ label: 'personal', token: '' }], gistAccount: 'personal', gistId: '', secret: '', deviceId: 'mac', storage: 'device' }));
    const w = window as any;
    w.held = []; w.runs = []; w.gates = {};
    const oid = (c: string) => c.repeat(40);
    w.viewedDesktop = {
      getSecret: async (n: string) => (n === 'token:personal' ? 'tok' : null),
      setSecret: async () => {},
      git: {
        pick: async () => null,
        list: async () => repos,
        info: (repo: string) => new Promise((res, rej) => w.held.push({ repo, res, rej })),
        run: async (repo: string, op: string, ref: string) => {
          w.runs.push(repo);
          await w.gates[repo];
          return op === 'resolve' ? oid(ref === 'refs/heads/main' ? 'e' : 'f') : op === 'mergeBase' ? oid('e') : '';
        },
      },
    };
  }, repos);
}
// 그 레포의 가장 오래된 대기 요청을 브랜치들(+main)로 푼다. 받은 쪽의 후속 처리(마이크로태스크)가 다 돌 때까지 기다린다
async function answer(page: Page, repo: string, branches: string[]) {
  await page.waitForFunction((r) => (window as any).held.some((h: { repo: string }) => h.repo === r), repo);
  await page.evaluate(async ([r, bs]) => {
    const w = window as any;
    const [h] = w.held.splice(w.held.findIndex((x: { repo: string }) => x.repo === r), 1);
    h.res({ refs: [...bs.map((b) => `refs/heads/${b}`), 'refs/heads/main'], defaultBase: null, current: `refs/heads/${bs[0]}`, remote: null });
    await new Promise((done) => setTimeout(done, 0));
  }, [repo, branches] as const);
}
const runs = (page: Page) => page.evaluate(() => [...new Set((window as any).runs as string[])]);
const waiting = (page: Page, repo: string) => page.waitForFunction((r) => (window as any).held.some((h: { repo: string }) => h.repo === r), repo);
async function pickRecent(page: Page, nth: number) {
  await page.getByTestId('local-recent').locator('summary').click();
  await page.getByTestId('recent-item').nth(nth).click();
}

// 최근 항목을 고르고 답을 기다리는 사이 폴더를 바꾸면 늦게 온 답으로 열지 않는다 — 칸은 바꾼 폴더 것
test('a recent pick still waiting for git is dropped when the folder is changed meanwhile', async ({ page }) => {
  await heldDesktop(page, ['/r/a', '/r/b', '/r/c']);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify({ local: {}, history: [
    { repo: '/r/b', branch: 'refs/heads/b1', base: 'refs/heads/main' }] })));
  await page.goto('/');
  await answer(page, '/r/a', ['a1']);
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/a1');
  await pickRecent(page, 0);
  await waiting(page, '/r/b');
  await page.getByTestId('local-repo-select').selectOption('/r/c');
  await answer(page, '/r/c', ['c1']);
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/c1');
  await answer(page, '/r/b', ['b1']);   // 늦게 온 B
  expect(await runs(page)).toEqual([]);
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/c');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/c1');
  await page.getByTestId('open-btn').click();   // 화면 값만이 아니라 상태도 C
  await expect(page.getByTestId('progress')).toHaveText('0 / 0');
  expect(await runs(page)).toEqual(['/r/c']);
});

// 잇달아 두 항목을 고르면 뒤의 것만 연다 — 앞의 답이 늦게 와도
test('of two recent picks in a row only the later opens, even when the earlier answer comes last', async ({ page }) => {
  await heldDesktop(page, ['/r/a', '/r/b', '/r/c']);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify({ local: {}, history: [
    { repo: '/r/b', branch: 'refs/heads/b1', base: 'refs/heads/main' }, { repo: '/r/c', branch: 'refs/heads/c1', base: 'refs/heads/main' }] })));
  await page.goto('/');
  await answer(page, '/r/a', ['a1']);
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/a1');
  await pickRecent(page, 0);
  await waiting(page, '/r/b');
  await pickRecent(page, 1);
  await waiting(page, '/r/c');
  await answer(page, '/r/c', ['c1']);
  await expect(page.getByTestId('progress')).toHaveText('0 / 0');
  await answer(page, '/r/b', ['b1']);   // 늦게 온 앞의 답
  expect(await runs(page)).toEqual(['/r/c']);
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/c');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/c1');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('viewed.recent') ?? '{}').last)).toMatchObject({ repo: '/r/c' });
});

// 최근 목록 전에 쓴 기록도 목록이 된다 — 마지막 로컬 레포가 먼저, 레포마다 한 번
test('records kept before the history fill the recent menu, the last local repo first and each once', async ({ page }) => {
  await heldDesktop(page, ['/r/a', '/r/b', '/r/c']);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify({
    last: { source: 'github', account: 'personal', repo: 'acme/widget', branch: 'feat', base: '' }, localRepo: '/r/c',
    local: { '/r/b': { branch: 'refs/heads/b1', base: 'refs/heads/main' }, '/r/c': { branch: 'refs/heads/c1', base: 'refs/heads/main' } } })));
  await page.goto('/');
  await page.getByTestId('source-local').click();
  await expect(page.getByTestId('recent-item').locator('span')).toHaveText(['c · c1 ← main', 'b · b1 ← main']);
  await expect(page.getByTestId('recent-item').locator('small')).toHaveText(['/r', '/r']);
});

// 비운 목록은 옛 기록으로 되살리지 않는다 — 항목이 없으면 버튼도 없다
test('an emptied history shows no recent menu even with older records', async ({ page }) => {
  await heldDesktop(page, ['/r/a', '/r/b']);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify({ history: [],
    last: { source: 'local', repo: '/r/b', branch: 'refs/heads/b1', base: 'refs/heads/main' }, local: { '/r/b': { branch: 'refs/heads/b1', base: 'refs/heads/main' } } })));
  await page.goto('/');
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/b');   // 폴더 목록을 받은 뒤
  await expect(page.getByTestId('local-recent')).toHaveCount(0);
});

// 브랜치·base 를 바꿔도 기다리던 최근 고르기는 버린다
test('changing the branch or the base also drops a recent pick still waiting for git', async ({ page }) => {
  await heldDesktop(page, ['/r/a', '/r/b']);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify({ local: {}, history: [
    { repo: '/r/b', branch: 'refs/heads/b1', base: 'refs/heads/main' }] })));
  await page.goto('/');
  await answer(page, '/r/a', ['a1', 'a2']);
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/a1');
  await pickRecent(page, 0);
  await waiting(page, '/r/b');
  await page.getByTestId('local-branch-select').selectOption('refs/heads/a2');
  await answer(page, '/r/b', ['b1']);
  expect(await runs(page)).toEqual([]);
  await pickRecent(page, 0);
  await waiting(page, '/r/b');
  await page.getByTestId('local-base-select').selectOption('refs/heads/a1');
  await answer(page, '/r/b', ['b1']);
  expect(await runs(page)).toEqual([]);
  await expect(page.getByTestId('local-repo-select')).toHaveValue('/r/a');
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/a2');
  await expect(page.getByTestId('local-base-select')).toHaveValue('refs/heads/a1');
});

// 최근 항목을 고르면 앞서 시작한 열기는 없던 일로 — 고른 것이 실패해도 앞의 열기가 늦게 올라오지 않는다
test('a recent pick cancels an open still loading, even when the pick then fails', async ({ page }) => {
  await heldDesktop(page, ['/r/a', '/r/b']);
  await page.addInitScript(() => localStorage.setItem('viewed.recent', JSON.stringify({ local: {}, history: [
    { repo: '/r/b', branch: 'refs/heads/gone', base: 'refs/heads/main' }] })));
  await page.goto('/');
  await answer(page, '/r/a', ['a1']);
  await expect(page.getByTestId('local-branch-select')).toHaveValue('refs/heads/a1');
  await page.evaluate(() => { const w = window as any; w.gates['/r/a'] = new Promise((r) => { w.release = r; }); });
  await page.getByTestId('open-btn').click();
  await expect.poll(() => runs(page)).toEqual(['/r/a']);   // a 열기가 git 에서 멈춰 있다
  await pickRecent(page, 0);
  await answer(page, '/r/b', ['b1']);   // 기억한 gone 브랜치가 없다
  await expect(page.getByTestId('error')).toHaveText("That review's branch or base no longer exists, so it was removed from the list.");
  await page.evaluate(async () => { (window as any).release(); await new Promise((done) => setTimeout(done, 0)); });
  expect(await history(page)).toEqual([]);   // 늦게 끝난 a 는 기록되지 않았다
  await expect(page.getByTestId('progress')).toHaveCount(0);
  await expect(page.getByTestId('error')).toBeVisible();
});
