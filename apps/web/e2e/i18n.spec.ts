import { test, expect } from '@playwright/test';
import { mockGitHub, seedSettings, viewedGist } from './fixtures';

test.use({ locale: 'ko-KR' });

test('a Korean browser gets Korean settings, with field names readable by screen readers', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('heading', { name: '설정' })).toBeVisible();
  await expect(page.getByLabel('공유 비밀')).toHaveAccessibleDescription(/모든 기기에 같은 값/);
  await expect(page.getByRole('link', { name: '토큰 만들기' })).toBeVisible();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-error')).toHaveText('모든 계정에 토큰이 필요합니다.');
});

test('a Korean browser gets Korean review screen and GitHub errors', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' }] });
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByRole('checkbox', { name: '확인함 a.ts' })).toBeVisible();
  await expect(page.locator('.progress')).toContainText('파일 확인함');

  await page.getByTestId('branch-input').fill('nope');   // 모의 서버에 없는 브랜치 → 500
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('error')).toContainText('GitHub 500');
  await expect(page.getByTestId('error')).toContainText('GitHub 요청이 실패했습니다.');
  await expect(page.getByTestId('error')).toContainText('/repos/acme/widget/branches/nope');   // 어느 요청이 실패했는지
});

test('a failed since-viewed lookup is shown in Korean too', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, {
    files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: '@@ -1 +1 @@\n-x\n+z' }],
    gistFiles: await viewedGist([{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' }]),
  });
  await page.route('https://api.github.com/repos/acme/widget/git/blobs/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
  await expect(page.getByTestId('since-error')).toContainText('토큰이 거부됐습니다');
});
