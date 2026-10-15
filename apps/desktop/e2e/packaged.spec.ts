import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `pnpm --filter @viewed/desktop package` 로 만든 .app 을 그대로 띄운다(없으면 건너뛴다)
const exe = join(__dirname, '..', 'out', 'viewed-darwin-arm64', 'viewed.app', 'Contents', 'MacOS', 'viewed');

test('the packaged app opens its bundled web build and reviews a local branch', async () => {
  test.skip(!existsSync(exe), 'not packaged');
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-repo-')));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.ts'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'b');
  git('checkout', '-q', '-b', 'feat'); writeFileSync(join(repo, 'a.ts'), 'a2\n'); git('commit', '-q', '-am', 'f');
  const app = await electron.launch({ executablePath: exe, args: ['--lang=en-US', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'viewed-'))}`] });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never; }, repo);
  const win = await app.firstWindow();
  expect(win.url()).toContain('app.asar/web-dist/index.html');
  await win.getByTestId('settings-save').click();
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await expect(win.getByTestId('diff')).toContainText('+a2');
  await app.close();
});
