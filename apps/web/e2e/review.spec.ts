import { test, expect, type Page } from '@playwright/test';
import { mockGitHub, seedSettings, viewedGist } from './fixtures';

const files = [
  { filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y' },
  { filename: 'logo.png', status: 'added', sha: 'p1' },   // patch 없음
];

async function open(page: Page) {
  await page.goto('/');
  await page.getByTestId('repo-input').fill('acme/widget');
  await page.getByTestId('branch-input').fill('feat');
  await page.getByTestId('open-btn').click();
}

test('checking a file raises progress, collapses its diff and syncs only this device file', async ({ page }) => {
  await seedSettings(page);
  const { gistPatches } = await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  await expect(row.getByTestId('diff')).toBeVisible();
  await row.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await expect(row.getByTestId('diff')).toBeHidden();
  await expect.poll(() => gistPatches.length, { timeout: 5000 }).toBe(1);
  const body = gistPatches[0] as { files: Record<string, { content: string }> };
  expect(Object.keys(body.files)).toEqual(['device-mac.json']);
  expect(body.files['device-mac.json'].content).not.toContain('a.ts');   // 이름 원문이 안 나간다
  expect(body.files['device-mac.json'].content).toContain('"viewed":true');
});

test('a file without a patch can be checked but shows no body', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'logo.png' });
  await expect(row.getByTestId('no-patch')).toBeVisible();
  await row.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
});

test('a fully viewed but 300-file list shows the banner and never says complete', async ({ page }) => {
  await seedSettings(page);
  const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified', sha: `s${i}`, patch: 'p' }));
  await mockGitHub(page, { files: many, gistFiles: await viewedGist(many) });
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('300 / 300');   // 전부 봤는데도
  await expect(page.getByTestId('banner-incomplete')).toBeVisible();
  await expect(page.getByTestId('complete')).toHaveCount(0);
});

test('the complete message shows for a fully viewed, saved list', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files, gistFiles: await viewedGist(files) });
  await open(page);
  await expect(page.getByTestId('complete')).toBeVisible();
});

test('a failed gist write shows sync error and hides complete', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await page.route('https://api.github.com/gists/g1', (r) =>
    r.request().method() === 'PATCH' ? r.fulfill({ status: 500, body: '{}' }) : r.fallback());
  await open(page);
  await expect(page.getByTestId('file-row')).toHaveCount(2);   // .all() 은 기다리지 않는다 — 먼저 목록이 뜨길 기다린다
  for (const row of await page.getByTestId('file-row').all()) await row.getByTestId('file-check').check();
  await expect(page.getByTestId('sync-status')).toHaveText('sync failed', { timeout: 5000 });
  await expect(page.getByTestId('progress')).toHaveText('2 / 2');
  await expect(page.getByTestId('complete')).toHaveCount(0);
});

test('a check that failed to save survives a reload and is sent again', async ({ page }) => {
  await seedSettings(page);
  let fail = true;
  const { gistPatches } = await mockGitHub(page, { files });
  await page.route('https://api.github.com/gists/g1', (r) =>
    r.request().method() === 'PATCH' && fail ? r.fulfill({ status: 500, body: '{}' }) : r.fallback());
  await open(page);
  await page.getByTestId('file-row').first().getByTestId('file-check').check();
  await expect(page.getByTestId('sync-status')).toHaveText('sync failed', { timeout: 5000 });
  fail = false;
  await page.reload();
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await expect.poll(() => gistPatches.length, { timeout: 5000 }).toBe(1);
});

test('a slow first save cannot overwrite a later one', async ({ page }) => {
  await seedSettings(page);
  const { gistPatches } = await mockGitHub(page, { files });
  let first = true;
  await page.route('https://api.github.com/gists/g1', async (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback();
    if (first) { first = false; await new Promise((res) => setTimeout(res, 2500)); }
    return r.fallback();
  });
  await open(page);
  const rows = page.getByTestId('file-row');
  await rows.nth(0).getByTestId('file-check').check();
  await page.waitForTimeout(1700);   // 1.5초 디바운스가 첫 저장을 보냄 — 응답이 2.5초 늦다
  await rows.nth(1).getByTestId('file-check').check();
  await expect.poll(() => gistPatches.length, { timeout: 8000 }).toBe(2);
  const last = gistPatches[1] as { files: Record<string, { content: string }> };
  expect(Object.keys(JSON.parse(last.files['device-mac.json'].content))).toHaveLength(2);
});

test('a patch ending in a newline gets no phantom line, and each check is named by its file', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files: [{ filename: 'a.ts', status: 'modified', sha: 'a1', patch: '@@ -1 +1 @@\n-x\n+y\n' }] });
  await open(page);
  await expect(page.getByTestId('diff').locator('.ln')).toHaveCount(3);
  await expect(page.getByRole('checkbox', { name: 'Viewed a.ts' })).toBeVisible();
});

test('the filter hides viewed files and says so when nothing is left', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await page.getByTestId('filter-unviewed').check();
  await expect(page.getByTestId('file-row')).toHaveCount(1);
  await expect(page.getByTestId('file-row')).toContainText('logo.png');
  await page.getByTestId('file-row').getByTestId('file-check').click();   // 체크하면 바로 목록에서 빠진다
  await expect(page.getByTestId('file-row')).toHaveCount(0);
  await expect(page.getByTestId('filter-empty')).toBeVisible();
  await page.getByTestId('filter-unviewed').uncheck();
  await expect(page.getByTestId('file-row')).toHaveCount(2);
});

test('the search box keeps files whose path contains the text, ignoring case and outer spaces', async ({ page }) => {
  await seedSettings(page);
  const tree = [
    { filename: 'src/Button.tsx', status: 'modified', sha: 'b1', patch: 'p' },
    { filename: 'src/api/client.ts', status: 'modified', sha: 'c1', patch: 'p' },
    { filename: 'docs/readme.md', status: 'modified', sha: 'd1', patch: 'p' },
  ];
  await mockGitHub(page, { files: tree });
  await open(page);
  const search = page.getByRole('searchbox', { name: 'Search files' });
  await search.fill('BUTT');                       // 대소문자 무시, 부분 문자열
  await expect(page.getByTestId('file-row')).toHaveCount(1);
  await expect(page.getByTestId('file-row')).toContainText('src/Button.tsx');
  await search.fill('  api/  ');                   // 폴더 이름도 맞고 앞뒤 공백은 무시
  await expect(page.getByTestId('file-row')).toHaveCount(1);
  await expect(page.getByTestId('file-row')).toContainText('src/api/client.ts');
  await search.fill('src');
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await search.fill('');
  await expect(page.getByTestId('file-row')).toHaveCount(3);
});

test('search combines with the viewed filter, leaves progress alone and says when nothing matches', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const search = page.getByRole('searchbox', { name: 'Search files' });
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await search.fill('.ts');
  await expect(page.getByTestId('file-row')).toHaveCount(1);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');   // 검색은 보이는 목록만 좁힌다
  await page.getByTestId('filter-unviewed').check();                // a.ts 는 확인함 → 둘 다 만족하는 것이 없다
  await expect(page.getByTestId('file-row')).toHaveCount(0);
  await expect(page.getByTestId('search-empty')).toBeVisible();
  await expect(page.getByTestId('filter-empty')).toHaveCount(0);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await search.fill('');                                            // 검색어 없이 0건이 아니므로 기존 문구
  await expect(page.getByTestId('file-row')).toHaveCount(1);
  await expect(page.getByTestId('search-empty')).toHaveCount(0);
  await page.getByTestId('file-row').getByTestId('file-check').click();
  await expect(page.getByTestId('filter-empty')).toBeVisible();
  await expect(page.getByTestId('search-empty')).toHaveCount(0);
});

// iOS 는 16px 미만 입력칸에 포커스하면 화면을 확대하고 안 되돌린다 — 크롬에선 안 보이니 글자 크기로 잰다.
// 가로로 돌린 폰(폭 844)은 폭 조건에 안 걸리고 pointer: coarse 로만 잡힌다
for (const [name, viewport] of [['portrait', { width: 360, height: 740 }], ['landscape', { width: 844, height: 390 }]] as const) {
  test.describe(`on a ${name} phone`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test('the search box is at least 16px and the progress bar does not overflow', async ({ page }) => {
      await seedSettings(page);
      await mockGitHub(page, { files });
      await open(page);
      const search = page.getByRole('searchbox', { name: 'Search files' });
      expect(parseFloat(await search.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      // 한 줄에 다 넣으면 진행 막대가 점으로 줄어든다(360 폭 실측 14px)
      expect(await page.locator('.meter').evaluate((el) => el.clientWidth)).toBeGreaterThanOrEqual(60);
      const over = await page.locator('.progress').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(over).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    });
  });
}

test('device-only storage keeps check marks across reloads and never calls the gist', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('viewed.settings', JSON.stringify({
    accounts: [{ label: 'personal', token: 'tok' }], gistAccount: 'personal', gistId: '', secret: 'k', deviceId: 'mac', storage: 'device' })));
  const { gistPatches } = await mockGitHub(page, { files });
  const gistCalls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/gists')) gistCalls.push(r.url()); });
  await open(page);
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await page.reload();
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  expect(gistCalls).toEqual([]);
  expect(gistPatches).toEqual([]);
});

test('switching storage to this device drops the open review, and later checks never reach the gist', async ({ page }) => {
  await seedSettings(page);
  const { gistPatches } = await mockGitHub(page, { files });
  await open(page);
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await page.getByTestId('settings-open').click();
  await page.getByTestId('storage-device').check();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('file-row')).toHaveCount(0);   // 옛 저장소에 묶인 화면은 버린다
  await page.getByTestId('open-btn').click();   // goto 하면 seedSettings 가 gist 설정을 다시 심는다 — 같은 페이지에서 다시 연다
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await page.waitForTimeout(2500);   // gist 저장 예약(1.5초)이 있었다면 지났다
  expect(gistPatches).toEqual([]);
});

test('device-only check marks do not depend on the shared secret', async ({ page }) => {
  const settings = (secret: string) => JSON.stringify({ accounts: [{ label: 'personal', token: 'tok' }], gistAccount: 'personal', gistId: '', secret, deviceId: 'mac', storage: 'device' });
  await page.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('viewed.settings', s); sessionStorage.setItem('seeded', '1'); } }, settings('first'));
  await mockGitHub(page, { files });
  await open(page);
  await page.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await page.evaluate((s) => localStorage.setItem('viewed.settings', s), settings('second'));   // gist 모드를 다녀오며 비밀이 바뀐 상황
  await page.reload();
  await open(page);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
});

test('refresh re-reads the branch in place and keeps the filter', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  await page.getByTestId('filter-unviewed').check();
  await mockGitHub(page, { files: [...files, { filename: 'c.ts', status: 'added', sha: 'c1', patch: '@@ -0,0 +1 @@\n+c' }] });   // 새 커밋이 생긴 것처럼
  await page.getByTestId('refresh-btn').click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 3');
  await expect(page.getByTestId('filter-unviewed')).toBeChecked();
});

test('refresh reads the branch with the token saved now, not the one it was opened with', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  const auth: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/compare/')) auth.push(r.headers()['authorization'] ?? ''); });
  await open(page);
  await page.getByTestId('settings-open').click();
  await page.getByLabel('token').fill('tok-new');
  await page.getByTestId('settings-save').click();
  await page.getByTestId('refresh-btn').click();
  await expect.poll(() => auth.length).toBe(2);
  expect(auth).toEqual(['Bearer tok', 'Bearer tok-new']);
});

// 확인한 파일 다시 보기 — 펼침은 화면 상태일 뿐, 체크·진행률·저장 기록을 건드리지 않는다
test('a viewed file opens again from its header, with check, progress and the gist record untouched', async ({ page }) => {
  await seedSettings(page);
  const { gistPatches } = await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  const head = row.getByTestId('file-expand');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await row.getByTestId('file-check').check();
  await expect(row.getByTestId('diff')).toBeHidden();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => gistPatches.length, { timeout: 5000 }).toBe(1);
  await head.click();
  await expect(row.getByTestId('diff')).toContainText('+y');   // 전체 diff(base...head)
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(row).toHaveAttribute('data-state', 'viewed');
  await expect(row.getByTestId('file-check')).toBeChecked();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await head.click();
  await expect(row.getByTestId('diff')).toBeHidden();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(2500);   // 저장이 예약됐다면 1.5초 디바운스가 지났다
  expect(gistPatches).toHaveLength(1);
});

test('opening a viewed file leaves the device-only record as it was', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('viewed.settings', JSON.stringify({
    accounts: [{ label: 'personal', token: 'tok' }], gistAccount: 'personal', gistId: '', secret: 'k', deviceId: 'mac', storage: 'device' })));
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  await row.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  const before = await page.evaluate(() => localStorage.getItem('viewed.device.mac'));
  expect(before).toContain('"viewed":true');
  await row.getByTestId('file-expand').click();
  await expect(row.getByTestId('diff')).toBeVisible();
  await row.getByTestId('file-expand').click();
  await expect(row.getByTestId('diff')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('viewed.device.mac'))).toBe(before);
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
});

test('a file folded by hand stays folded on refresh, and opens again when a new commit changes it', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  await row.getByTestId('file-expand').click();   // 안 본 파일도 접을 수 있다
  await expect(row.getByTestId('diff')).toBeHidden();
  await expect(row).toHaveAttribute('data-state', 'unread');
  // 새 커밋이 다른 파일만 더했다 — a.ts 지문은 그대로. 진행률 '0 / 3' 이 이 다시 읽기가 화면에 올라왔다는 표식이다
  await mockGitHub(page, { head: 'h2', files: [...files, { filename: 'c.ts', status: 'added', sha: 'c1', patch: '@@ -0,0 +1 @@\n+c' }] });
  await page.getByTestId('refresh-btn').click();   // 내용이 같으면 접은 채로
  await expect(page.getByTestId('progress')).toHaveText('0 / 3');
  await expect(row.getByTestId('file-expand')).toHaveAttribute('aria-expanded', 'false');
  await expect(row.getByTestId('diff')).toBeHidden();
  await mockGitHub(page, { files: [{ filename: 'a.ts', status: 'modified', sha: 'a2', patch: '@@ -1 +1,2 @@\n-x\n+y\n+z' }, files[1]] });
  await page.getByTestId('refresh-btn').click();   // 새 커밋이 이 파일을 바꿨다 — 바뀐 줄이 숨지 않게 다시 펼친다
  await expect(row.getByTestId('diff')).toContainText('+z');
  await expect(row.getByTestId('file-expand')).toHaveAttribute('aria-expanded', 'true');
});

test('checking folds and unchecking opens, whatever the header was set to', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  const head = row.getByTestId('file-expand');
  await head.click();   // 안 본 파일을 접어 둔 채로
  await row.getByTestId('file-check').check();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await row.getByTestId('file-check').uncheck();   // 풀면 펼친다 — 접어 둔 선택이 남지 않는다
  await expect(row.getByTestId('diff')).toBeVisible();
  await row.getByTestId('file-check').check();
  await head.click();   // 확인한 파일을 펼쳐 둔 채로
  await expect(row.getByTestId('diff')).toBeVisible();
  await row.getByTestId('file-check').uncheck();
  await expect(row.getByTestId('diff')).toBeVisible();
  await row.getByTestId('file-check').check();   // 다시 체크하면 접는다 — 펼쳐 둔 선택이 남지 않는다
  await expect(row.getByTestId('diff')).toBeHidden();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
});

// 체크·해제 직후 판정(buildReview)은 비동기라 한 번은 옛 state 로 그려진다 — 그때 반대 펼침이 잠깐이라도 DOM 에 오르면 깜빡임이다
test('checking or unchecking never flashes the opposite fold state first', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  const head = row.getByTestId('file-expand');
  // aria-expanded 가 바뀔 때마다 그 값을 적는다
  const watch = () => head.evaluate((el) => {
    const w = window as unknown as { seen: (string | null)[] };
    w.seen = [];
    new MutationObserver(() => w.seen.push(el.getAttribute('aria-expanded'))).observe(el, { attributes: true, attributeFilter: ['aria-expanded'] });
  });
  const seen = () => page.evaluate(() => (window as unknown as { seen: (string | null)[] }).seen);
  await head.click();   // 안 본 파일을 접어 둔 채로 체크 — 펼쳐지면 안 된다
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await watch();
  await row.getByTestId('file-check').check();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  expect(await seen()).toEqual([]);
  await head.click();   // 확인한 파일을 펼쳐 둔 채로 해제 — 접히면 안 된다
  await expect(row.getByTestId('diff')).toBeVisible();
  await watch();
  await row.getByTestId('file-check').uncheck();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  expect(await seen()).toEqual([]);
});

// 경로는 버튼 밖의 글자라 드래그로 골라 복사할 수 있다. 버튼 이름에는 경로가 든다 — 스크린 리더가 어느 파일의 버튼인지 알게
test('the path is plain text outside the expand button, and the button is named after the path', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  const head = row.getByTestId('file-expand');
  const path = row.locator('.file-head span.path');
  await expect(path).toHaveText('a.ts');
  expect(await path.evaluate((el) => el.closest('button') === null && getComputedStyle(el).userSelect !== 'none')).toBe(true);
  await expect(head).not.toContainText('a.ts');
  await expect(head).toHaveAccessibleName('Show or hide the diff of a.ts');
  await expect(page.getByRole('button', { name: /a\.ts/ })).toHaveAttribute('data-testid', 'file-expand');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
});

// 머리 줄의 빈 곳을 누르면 꺾쇠처럼 펼치고 접는다. 경로 글자는 고르는 데만 쓴다 — 더블클릭으로 파일 이름을 복사할 때 첫 클릭에 펼침이 바뀌지 않게
test('clicking the path text keeps the fold, and an empty spot of the header toggles it like the chevron', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  const head = row.getByTestId('file-expand');
  const bar = row.locator('.file-head');
  const path = row.locator('.file-head span.path');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await path.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(row.getByTestId('diff')).toBeVisible();
  // 경로 글자와 체크 라벨 사이의 빈 곳 — 경로 클릭이 펼침을 바꿨다면 여기서 다시 펼쳐져 아래 검사가 실패한다
  const textRight = await path.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().right; });
  const labelLeft = (await row.locator('label.viewed-toggle').boundingBox())!.x;
  const box = (await bar.boundingBox())!;
  const gap = { x: (textRight + labelLeft) / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, gap)).toBe('file-head');   // 경로 칸이 아니라 머리 자신
  await page.mouse.click(gap.x, gap.y);
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(row.getByTestId('diff')).toBeHidden();
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);   // 체크 라벨 오른쪽의 여백 — 머리 자신
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(row.getByTestId('diff')).toBeVisible();
  await head.click();   // 꺾쇠는 한 번만 바뀐다 — 머리 토글이 겹치면 그대로 펼쳐져 있다
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  // 손가락 모양은 머리 빈 곳에만 — 경로 글자는 고를 수 있는 글자 모양
  expect(await bar.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  expect(await path.evaluate((el) => getComputedStyle(el).cursor)).toBe('text');
});

test('double-clicking the path to copy the file name keeps the fold', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  const head = row.getByTestId('file-expand');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await row.locator('.file-head span.path').dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');   // 실제로 골라졌다 — 안 골라졌으면 이 검사는 공허하다
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(row.getByTestId('diff')).toBeVisible();
});

// 체크박스와 그 라벨은 머리 안에 있다 — 머리 토글이 겹치면 체크 규칙(체크=접기, 해제=펼치기) 위에 한 번 더 뒤집힌다.
// 라벨 글자 클릭은 라벨·입력 두 번의 click 이라, 겹치면 끝 상태는 맞아도 중간에 접혔다 펼쳐진다(본문이 다시 그려져 탭 선택도 잃는다)
test('the checkbox and its label in the header follow the check rule, without a second toggle from the header', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  const head = row.getByTestId('file-expand');
  // aria-expanded 가 바뀔 때마다 그 값을 적는다
  const watch = () => head.evaluate((el) => {
    const w = window as unknown as { seen: (string | null)[] };
    w.seen = [];
    new MutationObserver(() => w.seen.push(el.getAttribute('aria-expanded'))).observe(el, { attributes: true, attributeFilter: ['aria-expanded'] });
  });
  const seen = () => page.evaluate(() => (window as unknown as { seen: (string | null)[] }).seen);
  await head.click();   // 안 본 파일을 접어 둔 채로 체크 — 접힌 채여야 한다
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await watch();
  await row.getByTestId('file-check').click();
  await expect(page.getByTestId('progress')).toHaveText('1 / 2');
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  expect(await seen()).toEqual([]);
  await head.click();   // 확인한 파일을 펼쳐 둔 채로 라벨 글자를 눌러 해제 — 펼친 채여야 한다
  await expect(row.getByTestId('diff')).toBeVisible();
  await watch();
  await row.locator('label.viewed-toggle').getByText('Viewed', { exact: true }).click();
  await expect(page.getByTestId('progress')).toHaveText('0 / 2');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  expect(await seen()).toEqual([]);
  await expect(row.getByTestId('diff')).toBeVisible();
});

test('drag-selecting the path keeps the fold as it was', async ({ page }) => {
  await seedSettings(page);
  await mockGitHub(page, { files });
  await open(page);
  const row = page.getByTestId('file-row').filter({ hasText: 'a.ts' });
  const head = row.getByTestId('file-expand');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  // 글자가 차지한 범위
  const r = await row.locator('.file-head span.path').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const b = range.getBoundingClientRect();
    return { x: b.x, y: b.y + b.height / 2, w: b.width };
  });
  await page.mouse.move(r.x + 1, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w - 1, r.y, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');   // 실제로 골라졌다 — 안 골라졌으면 이 검사는 공허하다
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(row.getByTestId('diff')).toBeVisible();
});
