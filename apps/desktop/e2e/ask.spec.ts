import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildArgs } = require('../ask/claude-run.cjs');
const P = require('../ask/prompt.cjs');

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=you@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-repo-')));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'a\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'a.ts'), 'a2\nsecond\n');
  git(dir, 'commit', '-q', '-am', 'why a2 exists');
  return { dir, head: git(dir, 'rev-parse', 'HEAD').trim() };
}

// 가짜 claude — 실제 claude 는 절대 돌리지 않는다. 인자·stdin 을 marker 폴더에 남긴다
function fakeClaude(home: string, marker: string) {
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'claude');
  writeFileSync(file, `#!/bin/sh
M='${marker}'
if [ "$1" = "--version" ]; then echo "2.1.305 (Claude Code)"; exit 0; fi
echo run >> "$M/runs"
printf '%s\\0' "$@" > "$M/argv"
if [ -f "$M/hang" ]; then
  [ -f "$M/deaf" ] && trap '' TERM
  sleep 30 &
  echo $! > "$M/child.tmp" && mv "$M/child.tmp" "$M/child"
  echo $$ > "$M/self.tmp" && mv "$M/self.tmp" "$M/self"
  sleep 30
  exit 0
fi
cat > "$M/stdin"
echo '{"type":"result","subtype":"success","is_error":false,"result":"because of the fake answer"}'
`);
  chmodSync(file, 0o755);
}

const opened: { app: ElectronApplication; dirs: string[] }[] = [];
test.afterEach(async () => {
  for (const o of opened.splice(0)) {
    await o.app.close().catch(() => {});
    for (const d of o.dirs) rmSync(d, { recursive: true, force: true });
  }
});

async function launch() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-home-')));
  const marker = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-marker-')));
  fakeClaude(home, marker);
  const userData = mkdtempSync(join(tmpdir(), 'viewed-'));
  const repo = makeRepo();
  const app = await electron.launch({
    args: ['.', '--lang=en-US', '--use-mock-keychain', `--user-data-dir=${userData}`], cwd: join(__dirname, '..'),
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' },
  });
  opened.push({ app, dirs: [home, marker, userData, repo.dir] });
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never; }, repo.dir);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, marker, repo };
}

const req = (repo: { dir: string; head: string }, over: object = {}) => ({
  id: 'q1', repo: repo.dir, head: repo.head, side: 'R', path: 'a.ts', line: 1, lineText: 'a2',
  question: 'why is this here?', history: [], lang: 'en', ...over,
});
const addRepo = (win: Page) => win.evaluate(() => (window as any).viewedDesktop.git.pick());
const ask = (win: Page, r: object) => win.evaluate((r) => (window as any).viewedDesktop.ask.start(r), r);
const readPid = (f: string) => { try { const n = Number(readFileSync(f, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : 0; } catch { return 0; } };
async function hungPids(marker: string) {
  await expect.poll(() => readPid(join(marker, 'child')) > 0 && readPid(join(marker, 'self')) > 0).toBe(true);
  return ['child', 'self'].map((f) => readPid(join(marker, f)));
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('asking a line runs claude once with the fixed args and returns its answer', async () => {
  const { app, win, marker, repo } = await launch();
  await addRepo(win);
  await win.evaluate(() => { (window as any).__stages = []; (window as any).viewedDesktop.ask.onProgress((p: any) => (window as any).__stages.push(p.stage)); });
  const res = await ask(win, req(repo));
  expect(res).toMatchObject({ ok: true, answer: 'because of the fake answer', source: { kind: 'none' } });
  expect(readFileSync(join(marker, 'runs'), 'utf8').trim().split('\n')).toHaveLength(1);
  const argv = readFileSync(join(marker, 'argv'), 'utf8').split('\0'); argv.pop();
  expect(argv).toEqual(buildArgs(P.INSTRUCTION, P.systemPrompt('en')));
  const stdin = readFileSync(join(marker, 'stdin'), 'utf8');
  expect(stdin).toContain('a2');
  expect(stdin).toContain('why a2 exists');
  await expect.poll(() => win.evaluate(() => (window as any).__stages)).toEqual(['queued', 'searching', 'answering']);
  await app.close();
});

test('a lineText that does not match is refused without running claude', async () => {
  const { app, win, marker, repo } = await launch();
  await addRepo(win);
  expect(await ask(win, req(repo, { lineText: 'not the line' }))).toEqual({ ok: false, error: 'invalid' });
  expect(existsSync(join(marker, 'runs'))).toBe(false);
  await app.close();
});

test('a folder that was not added is refused', async () => {
  const { app, win, marker, repo } = await launch();
  expect(await ask(win, req(repo))).toEqual({ ok: false, error: 'invalid' });
  expect(existsSync(join(marker, 'runs'))).toBe(false);
  await app.close();
});

test('reloading the window kills a running question and its child', async () => {
  const { app, win, marker, repo } = await launch();
  await addRepo(win);
  writeFileSync(join(marker, 'hang'), '');
  const pending = win.evaluate((r) => (window as any).viewedDesktop.ask.start(r).then(() => 'done', () => 'rejected'), req(repo));
  const pids = await hungPids(marker);
  expect(pids.every(alive)).toBe(true);
  void pending.catch(() => {});
  await win.reload();
  await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false);
  await app.close();
});

test('closing the app kills a running question and its SIGTERM-ignoring child before exit', async () => {
  const { app, win, marker, repo } = await launch();
  await addRepo(win);
  writeFileSync(join(marker, 'hang'), ''); writeFileSync(join(marker, 'deaf'), '');
  void win.evaluate((r) => (window as any).viewedDesktop.ask.start(r).catch(() => null), req(repo)).catch(() => {});
  const pids = await hungPids(marker);
  expect(pids.every(alive)).toBe(true);
  await app.close();
  expect(pids.some(alive)).toBe(false);   // 종료 직후 — SIGKILL 유예(2 s)가 끝나기 전에 앱이 먼저 죽어선 안 된다
});
