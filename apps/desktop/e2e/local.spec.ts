import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
async function launch(repo: string, reuse?: string): Promise<{ app: ElectronApplication; win: Page; github: string[]; userData: string }> {
  const userData = reuse ?? mkdtempSync(join(tmpdir(), 'viewed-'));
  const app = await electron.launch({ args: ['.', '--lang=en-US', `--user-data-dir=${userData}`], cwd: join(__dirname, '..') });
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

// 브랜치만 지워지고 base 는 남았을 때 base 만 기억값을 쓰면 체크아웃(main)과 겹쳐 main...main 이 된다
test('when only the remembered branch is gone, its base is not kept either', async () => {
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
  await expect(win.getByTestId('local-base-select')).toHaveValue('refs/heads/main');   // 브랜치가 없으면 기억한 base 도 안 쓴다 — 쌍으로 규칙 값
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
