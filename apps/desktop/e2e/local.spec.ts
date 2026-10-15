import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
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

async function launch(repo: string): Promise<{ app: ElectronApplication; win: Page; github: string[] }> {
  const userData = mkdtempSync(join(tmpdir(), 'viewed-'));
  const app = await electron.launch({ args: ['.', '--lang=en-US', `--user-data-dir=${userData}`], cwd: join(__dirname, '..') });
  // 폴더 대화상자는 테스트 레포를 고른 것으로
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never; }, repo);
  const win = await app.firstWindow();
  const github: string[] = [];   // 기기 저장 + 로컬 폴더면 GitHub 에 한 건도 안 가야 한다
  await win.route('https://api.github.com/**', (r) => { github.push(r.request().url()); return r.abort(); });
  // 첫 실행 기본값: 이 기기에만 저장, 계정 없음 — 바로 저장되고, GitHub 계정이 없으니 소스 전환 없이 로컬 폴더 폼이 뜬다
  await expect(win.getByTestId('storage-device')).toBeChecked();
  await win.getByTestId('settings-save').click();
  await expect(win.getByTestId('source-local')).toHaveCount(0);
  await expect(win.getByTestId('local-add')).toBeVisible();
  return { app, win, github };
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
