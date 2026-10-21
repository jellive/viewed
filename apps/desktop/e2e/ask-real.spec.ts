import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 실제 claude 를 한 번 돌린다(구독 사용량 1회분). `VIEWED_REAL_CLAUDE=1` 일 때만, 패키징된 앱으로.
const exe = join(__dirname, '..', 'out', 'viewed-darwin-arm64', 'viewed.app', 'Contents', 'MacOS', 'viewed');

test('the packaged app asks the real claude about a diff line, with a Finder-like env', async () => {
  test.skip(process.env.VIEWED_REAL_CLAUDE !== '1', 'set VIEWED_REAL_CLAUDE=1 to run the real claude');
  test.skip(!existsSync(exe), 'not packaged');
  test.setTimeout(240_000);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-repo-')));
  const userData = mkdtempSync(join(tmpdir(), 'viewed-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=you@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.ts'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat'); writeFileSync(join(repo, 'a.ts'), 'a2\n'); git('commit', '-q', '-am', 'rename a to a2');
  const head = git('rev-parse', 'HEAD').trim();
  // Finder 가 앱을 띄울 때와 같게 — 최소 PATH, CLAUDE_CONFIG_DIR 없음
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const k of ['HOME', 'USER', 'LANG', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k] as string;
  const app = await electron.launch({ executablePath: exe, args: ['--lang=en-US', `--user-data-dir=${userData}`], env });
  try {
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never; }, repo);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => (window as any).viewedDesktop.git.pick());
    const t0 = Date.now();
    const res = await win.evaluate((r) => (window as any).viewedDesktop.ask.start(r), {
      id: 'real1', repo, head, side: 'R', path: 'a.ts', line: 1, lineText: 'a2', question: 'why was this line changed?', history: [], lang: 'en',
    });
    const elapsed = Date.now() - t0;
    console.log(`real claude: ok=${res.ok} answerLength=${res.answer?.length ?? 0} elapsedMs=${elapsed}`);
    expect(res.ok).toBe(true);
    expect(typeof res.answer).toBe('string');
    expect(res.answer.trim().length).toBeGreaterThan(0);
    expect(res.account === null || typeof res.account === 'string').toBe(true);
  } finally {
    await app.close().catch(() => {});
    rmSync(repo, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true });
  }
});
