import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = join(__dirname, '..');
const launch = (dir: string) => electron.launch({ args: ['.', `--user-data-dir=${dir}`], cwd });
const tmp = () => mkdtempSync(join(tmpdir(), 'viewed-'));

let server: Server;
let evilUrl = '';
test.beforeAll(async () => {
  server = createServer((_q, r) => {
    r.setHeader('content-type', 'text/html');
    r.end('<title>evil</title><body>evil</body>');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  evilUrl = `http://127.0.0.1:${(server.address() as any).port}/evil.html`;
});
test.afterAll(() => new Promise((ok) => server.close(ok)));

test('B1a: page cannot navigate the window to a remote document', async () => {
  const app = await launch(tmp());
  const win = await app.firstWindow();
  await expect(win.getByTestId('settings-form')).toBeVisible();
  await win.evaluate((u) => { location.href = u; }, evilUrl).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  expect(win.url()).toMatch(/^file:\/\/.*index\.html/);
  expect(await win.evaluate(() => document.title)).toBe('viewed');
  await app.close();
});

test('B1b: window.open creates no new window', async () => {
  const app = await launch(tmp());
  const win = await app.firstWindow();
  await expect(win.getByTestId('settings-form')).toBeVisible();
  await win.evaluate((u) => { window.open(u); }, evilUrl);
  await new Promise((r) => setTimeout(r, 1500));
  expect(app.windows().length).toBe(1);
  await app.close();
});

test('B2: concurrent setSecret keeps every key', async () => {
  const app = await launch(tmp());
  const win = await app.firstWindow();
  await expect(win.getByTestId('settings-form')).toBeVisible();
  const got = await win.evaluate(async () => {
    const d = (window as any).viewedDesktop;
    await Promise.all([d.setSecret('token:a', 'A'), d.setSecret('token:b', 'B'), d.setSecret('token:c', 'C')]);
    return [await d.getSecret('token:a'), await d.getSecret('token:b'), await d.getSecret('token:c')];
  });
  expect(got).toEqual(['A', 'B', 'C']);
  await app.close();
});

test('B3: corrupt secrets.json is quarantined on set; get on it still rejects', async () => {
  const dir = tmp();
  const file = join(dir, 'secrets.json');
  writeFileSync(file, '{"token:a":"');
  const app = await launch(dir);
  const win = await app.firstWindow();
  await expect(win.getByTestId('settings-form')).toBeVisible();
  const g = await win.evaluate(() => (window as any).viewedDesktop.getSecret('token:a').then(() => 'ok', () => 'rejected'));
  expect(g).toBe('rejected');
  expect(readFileSync(file, 'utf8')).toBe('{"token:a":"');
  await win.evaluate(() => (window as any).viewedDesktop.setSecret('token:b', 'B'));
  const q = readdirSync(dir).filter((n) => n.startsWith('secrets.json.corrupt-'));
  expect(q.length).toBe(1);
  expect(readFileSync(join(dir, q[0]), 'utf8')).toBe('{"token:a":"');
  expect(statSync(join(dir, q[0])).mode & 0o777).toBe(0o600);
  expect(await win.evaluate(() => (window as any).viewedDesktop.getSecret('token:b'))).toBe('B');
  expect(existsSync(file + '.tmp')).toBe(false);
  await app.close();
});

test('B3b: an unreadable secrets.json (EACCES) makes set reject and leaves the file untouched', async () => {
  const dir = tmp();
  const file = join(dir, 'secrets.json');
  writeFileSync(file, '{"token:a":"x"}');
  chmodSync(file, 0o000);
  const app = await launch(dir);
  try {
    const win = await app.firstWindow();
    await expect(win.getByTestId('settings-form')).toBeVisible();
    const r = await win.evaluate(() => (window as any).viewedDesktop.setSecret('token:b', 'B').then(() => 'ok', () => 'rejected'));
    expect(r).toBe('rejected');
    expect(readdirSync(dir).filter((n) => n.includes('corrupt'))).toEqual([]);
  } finally {
    await app.close();
    chmodSync(file, 0o600);
  }
  expect(readFileSync(file, 'utf8')).toBe('{"token:a":"x"}');
});

test('N1: a same-document URL change away from the app page makes the bridge forbidden', async () => {
  const app = await launch(tmp());
  const win = await app.firstWindow();
  await expect(win.getByTestId('settings-form')).toBeVisible();
  const r = await win.evaluate(() => {
    try { history.pushState({}, '', 'file:///remote-ish.html'); } catch (e) { return 'pushState-threw'; }
    return (window as any).viewedDesktop.getSecret('x').then(() => 'ok', (e: Error) => String(e.message));
  });
  expect(r).toContain('forbidden sender');
  await app.close();
});

test('B4: user-data-dir containing "=" is used verbatim', async () => {
  const base = tmp();
  const dir = join(base, 'a=b');
  mkdirSync(dir);
  const app = await launch(dir);
  const win = await app.firstWindow();
  await expect(win.getByTestId('settings-form')).toBeVisible();
  await win.evaluate(() => (window as any).viewedDesktop.setSecret('token:a', 'A'));
  expect(existsSync(join(dir, 'secrets.json'))).toBe(true);
  await app.close();
});
