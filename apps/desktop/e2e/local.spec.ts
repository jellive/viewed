import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-repo-')));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'a\n'); writeFileSync(join(dir, 'b.ts'), 'b\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'a.ts'), 'a2\n'); writeFileSync(join(dir, 'b.ts'), 'b2\n');
  git(dir, 'commit', '-q', '-am', 'feat');   // 푸시하지 않은 커밋
  return dir;
}

// 폴더 대화상자는 이 레포를 고른 것으로
const pickNext = (app: ElectronApplication, p: string) =>
  app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never; }, p);

// userData 를 넘기면 그 앱 데이터로 다시 띄운다 — 설정은 이미 저장돼 있다
// launch 가 만든 임시 HOME — 테스트가 끝나면 지운다
const homes: string[] = [];
test.afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

async function launch(repo: string, reuse?: string): Promise<{ app: ElectronApplication; win: Page; github: string[]; userData: string }> {
  const userData = reuse ?? mkdtempSync(join(tmpdir(), 'viewed-'));
  const home = mkdtempSync(join(tmpdir(), 'viewed-home-')); homes.push(home);
  // --use-mock-keychain: 설정 저장(safeStorage)이 진짜 키체인을 안 쓰게 — HOME 을 비우면 macOS 가 "키체인을 찾을 수 없음" 창을 띄운다
  const app = await electron.launch({ args: ['.', '--lang=en-US', '--use-mock-keychain', `--user-data-dir=${userData}`], cwd: join(__dirname, '..'),
    // 이 기기의 전역 git 신원(~/.gitconfig)이 테스트 레포 작성자('t')를 '남'으로 만들지 않게 — 신원이 없으면 전부 내 것이다
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '' } });
  await pickNext(app, repo);
  const win = await app.firstWindow();
  const github: string[] = [];   // 기기 저장 + 로컬 폴더면 GitHub 에 한 건도 안 가야 한다
  await win.route('https://api.github.com/**', (r) => { github.push(r.request().url()); return r.abort(); });
  // 첫 실행 기본값: 이 기기에만 저장, 계정 없음 — 바로 저장되고, GitHub 계정이 없으니 소스 전환 없이 로컬 폴더 폼이 뜬다
  if (!reuse) {
    await expect(win.getByTestId('storage-device')).toBeChecked();
    await win.getByTestId('settings-save').click();
  }
  await expect(win.getByTestId('source-local')).toHaveCount(0);
  await expect(win.getByTestId('local-add')).toBeVisible();
  return { app, win, github, userData };
}

async function openLocal(win: Page) {
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/main');
  await win.getByTestId('open-btn').click();
}

test('a local branch with unpushed commits can be reviewed, and a new commit unchecks only the changed file', async () => {
  const repo = makeRepo();
  const { app, win, github } = await launch(repo);
  await win.getByTestId('local-add').click();
  await openLocal(win);
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');
  await expect(win.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('diff')).toContainText('+a2');
  for (const row of await win.getByTestId('file-row').all()) await row.getByTestId('file-check').check();
  await expect(win.getByTestId('progress')).toHaveText('2 / 2');

  writeFileSync(join(repo, 'b.ts'), 'b3\n');
  git(repo, 'commit', '-q', '-am', 'more');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('1 / 2');
  const b = win.getByTestId('file-row').filter({ hasText: 'b.ts' });
  await expect(b).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(b.getByTestId('since-diff')).toContainText('+b3');   // 확인 후 바뀐 줄만, 로컬 blob 으로
  await expect(win.getByTestId('file-row').filter({ hasText: 'a.ts' })).toHaveAttribute('data-state', 'viewed');
  expect(github).toEqual([]);
  await app.close();
});

test('the git bridge refuses folders that were not added and refs or ids that are not plain', async () => {
  const repo = makeRepo();
  const { app, win } = await launch(repo);
  const call = (repoPath: string, op: string, a: string, b?: string) =>
    win.evaluate(([r, o, x, y]) => (window as any).viewedDesktop.git.run(r, o, x, y).then(() => 'ok', (e: Error) => e.message), [repoPath, op, a, b] as const);
  expect(await call(repo, 'resolve', 'refs/heads/main')).toContain('repository not added');
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  expect(await call(repo, 'resolve', 'refs/heads/main')).toBe('ok');
  expect(await call(repo, 'resolve', '--output=/tmp/x')).toContain('bad ref');
  expect(await call(repo, 'resolve', 'main')).toContain('bad ref');
  expect(await call(repo, 'mergeBase', 'HEAD', 'HEAD')).toContain('bad object id');
  expect(await call(repo, 'nope', 'x')).toContain('unknown git op');
  await app.close();
});

test('a repo whose diff.submodule config would make git run a nested diff still opens, and the submodule shows without a diff', async () => {
  const sub = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-sub-')));
  git(sub, 'init', '-q', '-b', 'main'); writeFileSync(join(sub, 's.txt'), '1\n'); git(sub, 'add', '-A'); git(sub, 'commit', '-q', '-m', 's1');
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-repo-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  writeFileSync(join(repo, 'a.ts'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feat');
  writeFileSync(join(sub, 's.txt'), '2\n'); git(sub, 'commit', '-q', '-am', 's2');
  git(join(repo, 'vendor/sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main');
  writeFileSync(join(repo, 'a.ts'), 'a2\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'bump');
  git(repo, 'config', 'diff.submodule', 'log');   // 이 설정이면 git 이 하위 diff 를 따로 돈다
  const { app, win } = await launch(repo);
  await win.getByTestId('local-add').click();
  await openLocal(win);
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');
  await expect(win.getByTestId('file-row').filter({ hasText: 'vendor/sub' }).getByTestId('no-patch')).toBeVisible();
  await expect(win.getByTestId('file-row').filter({ hasText: 'a.ts' }).getByTestId('diff')).toContainText('+a2');
  await app.close();
});

test('a new commit on the open local branch shows up by itself', async () => {
  const repo = makeRepo();
  const { app, win } = await launch(repo);
  await win.getByTestId('local-add').click();
  await openLocal(win);
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');
  writeFileSync(join(repo, 'c.ts'), 'c\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'live');
  await expect(win.getByTestId('progress')).toHaveText('0 / 3', { timeout: 10_000 });   // 버튼을 안 눌러도
  await app.close();
});

// feat 를 체크아웃해 둔 레포에 x(main 에서 갈라짐)와 old(main 과 같음) 브랜치를 더한다
function makeRepoWithX() {
  const dir = makeRepo();
  git(dir, 'branch', 'old', 'main');
  git(dir, 'checkout', '-q', '-b', 'x', 'main');
  writeFileSync(join(dir, 'x.ts'), 'x\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'x');
  git(dir, 'checkout', '-q', 'feat');
  return dir;
}

test('switching repos picks the branch and base last opened in that repo, without opening it', async () => {
  const a = makeRepoWithX(), b = makeRepo();
  const { app, win } = await launch(a);
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await win.getByTestId('local-branch-select').selectOption('refs/heads/x');
  await win.getByTestId('local-base-select').selectOption('refs/heads/old');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await win.getByTestId('local-branch-select').selectOption('refs/heads/feat');   // 열지 않은 선택은 기억하지 않는다
  await pickNext(app, b);
  await win.getByTestId('local-add').click();
  await openLocal(win);   // B 는 기억이 없다 — 체크아웃 브랜치
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');
  await win.getByTestId('local-repo-select').selectOption(a);
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/x');
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/old');
  await win.waitForTimeout(500);
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');   // 고르기만 하고 열지 않는다 — B 의 리뷰가 그대로
  await win.getByTestId('local-repo-select').selectOption(b);
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await app.close();
});

test('a remembered branch or base that was deleted falls back to the usual pick', async () => {
  const a = makeRepoWithX(), b = makeRepo();
  const { app, win } = await launch(a);
  await win.getByTestId('local-add').click();
  await win.getByTestId('local-branch-select').selectOption('refs/heads/x');
  await win.getByTestId('local-base-select').selectOption('refs/heads/old');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await pickNext(app, b);
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  git(a, 'branch', '-D', 'x', 'old');
  await win.getByTestId('local-repo-select').selectOption(a);
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');   // 체크아웃 브랜치
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/main');
  await win.getByTestId('open-btn').click();   // 화면 값만이 아니라 상태도 — 없는 값을 고른 select 는 첫 항목을 보여 준다
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');
  await app.close();
});

// 브랜치·base 기억은 각자 살아 있으면 쓴다 — release 처럼 고정 base 로 기능 브랜치를 오가다 기능 브랜치를 지워도 base 는 남는다
async function openXOldThenSwitchToB(a: string, b: string) {
  const { app, win } = await launch(a);
  await win.getByTestId('local-add').click();
  await win.getByTestId('local-branch-select').selectOption('refs/heads/x');
  await win.getByTestId('local-base-select').selectOption('refs/heads/old');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await pickNext(app, b);
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  return { app, win };
}

test('when only the remembered branch is gone, the remembered base that is still there is kept', async () => {
  const a = makeRepoWithX(), b = makeRepo();
  const { app, win } = await openXOldThenSwitchToB(a, b);
  git(a, 'branch', '-D', 'x');
  await win.getByTestId('local-repo-select').selectOption(a);
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');   // 체크아웃 브랜치
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/old');   // 기억한 base
  await app.close();
});

test('when only the remembered base is gone, the remembered branch that is still there is kept', async () => {
  const a = makeRepoWithX(), b = makeRepo();
  const { app, win } = await openXOldThenSwitchToB(a, b);
  git(a, 'branch', '-D', 'old');
  await win.getByTestId('local-repo-select').selectOption(a);
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/x');   // 기억한 브랜치
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/main');   // 규칙 값
  await app.close();
});

// 브랜치가 지워져 체크아웃(main)이 브랜치가 됐는데 기억한 base 도 main 이면 main...main 이 된다 — 그때만 base 는 규칙 값
test('when the remembered branch is gone and the checkout is the remembered base, the base takes the usual rule', async () => {
  const a = makeRepoWithX(), b = makeRepo();
  git(a, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
  git(a, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');   // 규칙의 base = origin/main
  const { app, win } = await launch(a);
  await win.getByTestId('local-add').click();
  await win.getByTestId('local-branch-select').selectOption('refs/heads/x');
  await win.getByTestId('local-base-select').selectOption('refs/heads/main');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await pickNext(app, b);
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  git(a, 'checkout', '-q', 'main');
  git(a, 'branch', '-D', 'x');
  await win.getByTestId('local-repo-select').selectOption(a);
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/main');   // 체크아웃 브랜치
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/remotes/origin/main');   // 기억한 main 이 아니라 규칙 값
  await app.close();
});

// a 를 더하고 x(base old)로 연 뒤 닫는다 — 다음 실행이 기억할 마지막 리뷰
async function openXAndQuit(a: string) {
  const { app, win, userData } = await launch(a);
  await win.getByTestId('local-add').click();
  await win.getByTestId('local-branch-select').selectOption('refs/heads/x');
  await win.getByTestId('local-base-select').selectOption('refs/heads/old');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  return { app, win, userData };
}

test('relaunching opens the last review by itself, not a selection that was never opened', async () => {
  const a = makeRepoWithX(), b = makeRepo();
  const first = await openXAndQuit(a);
  await first.win.getByTestId('local-branch-select').selectOption('refs/heads/feat');   // 고르기만 하고
  await pickNext(first.app, b);
  await first.win.getByTestId('local-add').click();   // 레포도 바꾸기만 하고 열지 않는다
  await expect(first.win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await first.app.close();

  const { app, win, github } = await launch(a, first.userData);
  await expect(win.getByTestId('local-repo-select')).toHaveValue(a);
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');   // 누르지 않아도 열린다
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/x');
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/old');
  expect(github).toEqual([]);
  await app.close();
});

test('a trip through settings does not open the last review again', async () => {
  const a = makeRepoWithX();
  const first = await openXAndQuit(a);
  await first.app.close();
  const { app, win } = await launch(a, first.userData);
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await win.getByTestId('settings-open').click();
  await win.getByLabel('device id').fill('other');   // 기기가 바뀌면 열린 화면을 버린다 — 다시 열리면 보이게
  await win.getByTestId('settings-save').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/x');   // 고르기는 하되
  await win.waitForTimeout(1000);
  await expect(win.getByTestId('file-row')).toHaveCount(0);   // 열지는 않는다
  await app.close();
});

test('the last review does not open by itself when its branch is gone', async () => {
  const a = makeRepoWithX();
  const first = await openXAndQuit(a);
  await first.app.close();
  git(a, 'branch', '-D', 'x');
  const { app, win } = await launch(a, first.userData);
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/old');   // 브랜치가 없어도 살아 있는 base 는 기억값
  await win.waitForTimeout(1000);
  await expect(win.getByTestId('file-row')).toHaveCount(0);
  await app.close();
});

test('the last review does not open by itself when its folder is gone, and the error shows as before', async () => {
  const a = makeRepoWithX();
  const first = await openXAndQuit(a);
  await first.app.close();
  rmSync(a, { recursive: true, force: true });
  const { app, win } = await launch(a, first.userData);
  await expect(win.getByTestId('error')).toBeVisible();
  await expect(win.getByTestId('file-row')).toHaveCount(0);
  await app.close();
});

// n줄(기본 12) 파일 f.ts — feat 커밋마다 edits 를 통째로 적용한다
const lines = (edits: Record<number, string> = {}, n = 12) => Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
function lineRepo(featCommits: Record<number, string>[], n = 12) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-rebase-')));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f.ts'), lines({}, n)); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat');
  for (const e of featCommits) { writeFileSync(join(dir, 'f.ts'), lines(e, n)); git(dir, 'commit', '-q', '-am', 'feat'); }
  return dir;
}
function commitOnMain(dir: string, edits: Record<number, string>, n = 12) {
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'f.ts'), lines(edits, n)); git(dir, 'commit', '-q', '-am', 'main moves');
  git(dir, 'checkout', '-q', 'feat');
}
async function openAndCheck(repo: string) {
  const { app, win } = await launch(repo);
  await win.getByTestId('local-add').click();
  await openLocal(win);
  const row = win.getByTestId('file-row').filter({ hasText: 'f.ts' });
  await row.getByTestId('file-check').check();
  await expect(win.getByTestId('progress')).toHaveText('1 / 1');
  return { app, win, row };
}

test('S1: rebasing onto a base that changed a nearby line keeps the file viewed', async () => {
  const repo = lineRepo([{ 8: 'line 8 FEAT' }]);
  const { app, win, row } = await openAndCheck(repo);
  commitOnMain(repo, { 6: 'line 6 DEV' });
  git(repo, 'rebase', '-q', 'main');
  await win.getByTestId('open-btn').click();
  // 배지는 새 판정에서만 나온다 — 다시 읽기 전 화면의 'viewed' 로 통과하지 않게 배지로 기다린다
  await expect(row.getByTestId('file-state')).toHaveText('Reviewed changes unchanged');
  await expect(row).toHaveAttribute('data-state', 'viewed');
  await app.close();
});

test('S2: part of my work squashed into base, then rebase — still viewed', async () => {
  const repo = lineRepo([{ 3: 'line 3 A' }, { 3: 'line 3 A', 10: 'line 10 B' }]);
  const { app, win, row } = await openAndCheck(repo);
  commitOnMain(repo, { 3: 'line 3 A' });
  git(repo, 'rebase', '-q', 'main');   // 첫 커밋은 main 에 같은 내용이 있어 git 이 건너뛴다
  await win.getByTestId('open-btn').click();
  // 확인한 블록 2개 중 line 3 이 base 로 들어가 diff 에서 빠졌다 — 확인함으로 두되 경고 배지
  await expect(row.getByTestId('file-state')).toHaveText('1 reviewed change dropped');
  await expect(row).toHaveAttribute('data-state', 'viewed');
  await app.close();
});

// 30줄 — 확인한 블록(line 8)과 새 블록(line 20)이 11줄 떨어져 diff 에서 서로 다른 덩어리가 된다
test('S3: merging base then changing a far line shows only the hunk with my new block', async () => {
  const repo = lineRepo([{ 8: 'line 8 FEAT' }], 30);
  const { app, win, row } = await openAndCheck(repo);
  commitOnMain(repo, { 2: 'line 2 DEV' }, 30);
  git(repo, 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(repo, 'f.ts'), lines({ 2: 'line 2 DEV', 8: 'line 8 FEAT', 20: 'line 20 FEAT2' }, 30));
  git(repo, 'commit', '-q', '-am', 'more');
  await win.getByTestId('open-btn').click();
  await expect(row).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row.getByTestId('since-blocks')).toBeVisible();
  await expect(row.getByTestId('since-diff')).toContainText('+line 20 FEAT2');
  await expect(row.getByTestId('since-diff')).not.toContainText('line 8 FEAT');   // 확인한 블록만 든 덩어리는 빠진다
  for (const line of await row.getByTestId('since-diff').locator('.ln.add, .ln.del').allTextContents()) expect(line).not.toContain('DEV');
  await row.getByTestId('full-tab').click();
  await expect(row.getByTestId('diff')).toContainText('+line 8 FEAT');
  await app.close();
});

// 새 파일은 diff 전체가 블록 하나다 — 머지 뒤 몇 줄만 지워도 파일 전체가 다시 뜨고 지운 줄은 안 보이던 것(2026-10-29 실사용)
test('S4: merging base then deleting lines of a new file shows only the deleted lines', async () => {
  const repo = lineRepo([{ 8: 'line 8 FEAT' }]);
  writeFileSync(join(repo, 'n.ts'), lines({}, 14)); git(repo, 'add', 'n.ts'); git(repo, 'commit', '-q', '-m', 'new file');
  const { app, win } = await launch(repo);
  await win.getByTestId('local-add').click();
  await openLocal(win);
  const row = win.getByTestId('file-row').filter({ hasText: 'n.ts' });
  await row.getByTestId('file-check').check();
  await expect(win.getByTestId('progress')).toHaveText('1 / 2');
  commitOnMain(repo, { 2: 'line 2 DEV' });
  git(repo, 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(repo, 'n.ts'), lines({}, 8)); git(repo, 'commit', '-q', '-am', 'drop 9-14');
  await win.getByTestId('open-btn').click();
  await expect(row).toHaveAttribute('data-state', 'changed-since-viewed');
  await expect(row.getByTestId('since-diff').locator('.ln.del')).toHaveText(['-line 9', '-line 10', '-line 11', '-line 12', '-line 13', '-line 14']);
  await expect(row.getByTestId('since-diff').locator('.ln.add')).toHaveCount(0);
  await expect(row.getByTestId('since-blocks')).toHaveCount(0);
  await app.close();
});

// 최근 목록 — 열기에 성공한 조합을 최근 것부터 보이고, 누르면 그 조합을 바로 연다
const storedHistory = (win: Page) => win.evaluate(() => JSON.parse(localStorage.getItem('viewed.recent') ?? '{}').history);
const at = (repo: string, branch: string, base: string) => ({ repo, branch: `refs/heads/${branch}`, base: `refs/heads/${base}` });

// 더한 a 에서 x←old, feat←main 순으로 연다 — 최근 목록은 [feat←main, x←old], a 의 레포별 기억은 feat←main
async function openXOldThenFeatMain(win: Page) {
  await win.getByTestId('local-branch-select').selectOption('refs/heads/x');
  await win.getByTestId('local-base-select').selectOption('refs/heads/old');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await win.getByTestId('local-branch-select').selectOption('refs/heads/feat');
  await win.getByTestId('local-base-select').selectOption('refs/heads/main');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');
}

test('R1: the recent menu lists opened reviews newest first, and one click opens the one picked', async () => {
  const a = makeRepoWithX(), b = makeRepo();
  const { app, win } = await launch(a);
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await expect(win.getByTestId('local-recent')).toHaveCount(0);   // 연 적이 없으면 버튼도 없다
  await openXOldThenFeatMain(win);
  await pickNext(app, b);
  await win.getByTestId('local-add').click();
  await openLocal(win);
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');
  const items = win.getByTestId('recent-item'), na = basename(a), nb = basename(b);
  await expect(items.locator('span')).toHaveText([`${nb} · feat ← main`, `${na} · feat ← main`, `${na} · x ← old`]);
  await expect(items.locator('small')).toHaveText([dirname(b), dirname(a), dirname(a)]);   // 같은 이름 폴더를 가르는 부모 경로
  await win.getByTestId('local-recent').locator('summary').click();
  await items.nth(2).click();   // 다른 레포의, 그 레포 기억(feat←main)과 다른 조합
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await expect(win.getByTestId('local-recent')).toHaveJSProperty('open', false);   // 누르면 닫힌다
  await expect(win.getByTestId('local-repo-select')).toHaveValue(a);
  await expect(items.locator('span')).toHaveText([`${na} · x ← old`, `${nb} · feat ← main`, `${na} · feat ← main`]);   // 다시 연 조합은 맨 위로, 한 번만
  expect(await storedHistory(win)).toEqual([at(a, 'x', 'old'), at(b, 'feat', 'main'), at(a, 'feat', 'main')]);
  await win.waitForTimeout(500);   // 레포를 바꾼 뒤에도 칸이 그 레포 기억으로 덮이지 않는다
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/x');
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/old');
  // 화면 값만이 아니라 상태도 — 다시 열기가 실제로 일어나 그 조합을 기록하는지 본다(다시 읽기는 기록하지 않는다)
  await win.evaluate(() => {
    const w = window as unknown as { opened: unknown[] };
    w.opened = [];
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) { if (k === 'viewed.recent') w.opened.push(JSON.parse(v).last); return orig.call(this, k, v); };
  });
  await win.getByTestId('open-btn').click();
  await expect.poll(() => win.evaluate(() => (window as unknown as { opened: unknown[] }).opened))
    .toEqual([{ source: 'local', ...at(a, 'x', 'old') }]);
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await app.close();
});

test('R2: a recent review whose branch was deleted is not opened, says so, and leaves the menu', async () => {
  const a = makeRepoWithX();
  const { app, win } = await launch(a);
  await win.getByTestId('local-add').click();
  await openXOldThenFeatMain(win);
  git(a, 'branch', '-D', 'x');
  await win.getByTestId('local-recent').locator('summary').click();
  await win.getByTestId('recent-item').nth(1).click();
  await expect(win.getByTestId('error')).toHaveText("That review's branch or base no longer exists, so it was removed from the list.");
  await expect(win.getByTestId('recent-item')).toHaveCount(1);
  expect(await storedHistory(win)).toEqual([at(a, 'feat', 'main')]);
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');   // 보던 리뷰 그대로
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await app.close();
});

// Tab 으로 항목을 지나가기만 해서는 안 열린다 — Enter 로 연다. Escape 는 닫고 펼침 버튼으로 돌아간다
test('R3: the recent menu works from the keyboard, and moving through it opens nothing', async () => {
  const a = makeRepoWithX();
  const { app, win } = await launch(a);
  await win.getByTestId('local-add').click();
  await openXOldThenFeatMain(win);
  const menu = win.getByTestId('local-recent'), summary = menu.locator('summary'), items = win.getByTestId('recent-item');
  await summary.focus();
  await win.keyboard.press('Enter');
  await expect(menu).toHaveJSProperty('open', true);
  await win.keyboard.press('Tab');
  await win.keyboard.press('Tab');
  await expect(items.nth(1)).toBeFocused();   // x ← old 위에 있기만
  await expect(menu).toHaveJSProperty('open', true);
  await win.waitForTimeout(500);
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await win.keyboard.press('Escape');
  await expect(menu).toHaveJSProperty('open', false);
  await expect(summary).toBeFocused();
  await win.keyboard.press('Enter');
  await win.keyboard.press('Tab');
  await win.keyboard.press('Tab');
  await win.keyboard.press('Enter');
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/x');
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/old');
  await app.close();
});

test('R4: a recent review of a folder that is not in the folder list is not shown', async () => {
  const a = makeRepo();
  const first = await launch(a);
  await first.win.getByTestId('local-add').click();
  await openLocal(first.win);
  await expect(first.win.getByTestId('progress')).toHaveText('0 / 2');
  await first.win.evaluate(() => {
    const r = JSON.parse(localStorage.getItem('viewed.recent') ?? '{}');
    r.history = [{ repo: '/nowhere/ghost', branch: 'refs/heads/feat', base: 'refs/heads/main' }, ...r.history];
    localStorage.setItem('viewed.recent', JSON.stringify(r));
  });
  await first.app.close();
  const { app, win } = await launch(a, first.userData);
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');   // 마지막 리뷰가 열렸다 — 폴더 목록을 받은 뒤
  await expect(win.getByTestId('recent-item').locator('span')).toHaveText([`${basename(a)} · feat ← main`]);
  expect((await storedHistory(win))[1]).toMatchObject({ repo: '/nowhere/ghost' });   // 기록에는 남아 있다
  await app.close();
});

test('others-only files collapse with a real repo, and others\' added lines get the other tint', async () => {
  const { makeOthersRepo } = require('../test/helpers.cjs') as { makeOthersRepo: () => string };
  const repo = makeOthersRepo();
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'alice']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'a@example.test']);
  const { app, win } = await launch(repo);
  await win.getByTestId('local-add').click();
  await openLocal(win);
  const b = win.getByTestId('file-row').filter({ hasText: 'b.ts' });
  await expect(b.getByTestId('file-others')).toBeVisible();
  await expect(b).toHaveAttribute('data-others', '1');
  await expect(b.getByTestId('file-check')).toBeChecked();
  await expect(b.getByTestId('file-check')).toBeDisabled();
  const mix = win.getByTestId('file-row').filter({ hasText: 'mix.ts' });
  await expect(mix.getByTestId('file-others')).toHaveCount(0);
  await expect(mix.getByTestId('diff')).toContainText('+b-line');
  await expect(mix.locator('.ln.add.other')).toHaveCount(1);
  await expect(mix.locator('.ln.add.other')).toContainText('b-line');
  await expect(mix.locator('.ln.add').filter({ hasText: 'a-line' })).not.toHaveClass(/other/);
  // alice 가 old.ts 를 고치고 bob 이 new.ts 로 이름만 바꿨다 — 새 경로는 남의 것이 아니다(이름 변경 쌍으로 이어 붙인다)
  const renamed = win.getByTestId('file-row').filter({ hasText: 'new.ts' });
  await expect(renamed).toHaveCount(1);
  await expect(renamed.getByTestId('file-others')).toHaveCount(0);
  await expect(renamed).toHaveAttribute('data-state', 'unread');
  await app.close();
});

test('a review opened against an older target keeps what was checked against the newer one', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-carry-')));
  const as = (who: string, ...a: string[]) => git(dir, '-c', `user.name=${who}`, '-c', `user.email=${who}@example.test`, ...a);
  const put = (f: string, c: string) => writeFileSync(join(dir, f), c);
  git(dir, 'init', '-q', '-b', 'main');
  put('a.ts', 'a\n'); git(dir, 'add', '-A'); as('alice', 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'integ');
  put('w.ts', 'w\n'); git(dir, 'add', '-A'); as('alice', 'commit', '-q', '-m', 'integ w');
  put('y.ts', 'y-integ\n'); git(dir, 'add', '-A'); as('bob', 'commit', '-q', '-m', 'integ y (new file)');   // vs integ: modified by alice, vs main: added
  git(dir, 'checkout', '-q', '-b', 'feat');
  put('y.ts', 'y-feat\n'); put('z.ts', 'z\n'); git(dir, 'add', '-A'); as('alice', 'commit', '-q', '-m', 'feat');

  const { app, win } = await launch(dir);
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await win.getByTestId('local-base-select').selectOption('refs/heads/integ');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 2');   // y, z
  for (const row of await win.getByTestId('file-row').all()) await row.getByTestId('file-check').check();
  await expect(win.getByTestId('progress')).toHaveText('2 / 2');

  await win.getByTestId('local-base-select').selectOption('refs/heads/main');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('file-row')).toHaveCount(3);   // w, y, z
  await expect(win.getByTestId('progress')).toHaveText('3 / 3');
  for (const f of ['w.ts', 'y.ts', 'z.ts']) await expect(win.getByTestId('file-row').filter({ hasText: f })).toHaveAttribute('data-state', 'viewed');

  put('z.ts', 'z2\n'); git(dir, 'add', '-A'); as('alice', 'commit', '-q', '-m', 'z again');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('file-row').filter({ hasText: 'z.ts' })).toHaveAttribute('data-state', 'changed-since-viewed');
  for (const f of ['w.ts', 'y.ts']) await expect(win.getByTestId('file-row').filter({ hasText: f })).toHaveAttribute('data-state', 'viewed');

  // 왕복: 앞선 대상(integ)으로 다시 열면 거기서 확인했던 y.ts 는 그대로 확인함이다
  await win.getByTestId('local-base-select').selectOption('refs/heads/integ');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('file-row')).toHaveCount(2);   // y, z
  await expect(win.getByTestId('file-row').filter({ hasText: 'y.ts' })).toHaveAttribute('data-state', 'viewed');
  await expect(win.getByTestId('file-row').filter({ hasText: 'z.ts' })).toHaveAttribute('data-state', 'changed-since-viewed');
  await app.close();
});
