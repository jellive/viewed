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
  const compares: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/compare/')) compares.push(r.url()); });
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
