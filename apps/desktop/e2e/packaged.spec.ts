import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
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
  // 이 기기의 전역 git 신원이 테스트 레포 작성자를 '남'으로 만들지 않게 HOME 을 비운다(local.spec.ts 와 같다)
  const home = mkdtempSync(join(tmpdir(), 'viewed-home-'));
  const app = await electron.launch({ executablePath: exe, args: ['--lang=en-US', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'viewed-'))}`],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '' } });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never; }, repo);
  const win = await app.firstWindow();
  expect(win.url()).toContain('app.asar/web-dist/index.html');
  await expect(win.getByTestId('storage-device')).toBeChecked();   // 설정이 읽힌 뒤에 저장한다(local.spec.ts launch 와 같다)
  await win.getByTestId('settings-save').click();
  await win.getByTestId('local-add').click();
  await expect(win.getByTestId('local-branch-select')).toHaveValue('refs/heads/feat');
  await win.getByTestId('open-btn').click();
  await expect(win.getByTestId('progress')).toHaveText('0 / 1');
  await expect(win.getByTestId('diff')).toContainText('+a2');
  await app.close();
  rmSync(home, { recursive: true, force: true });
});
