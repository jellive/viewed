import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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

test('B3: corrupt secrets.json is not overwritten', async () => {
  const dir = tmp();
  const file = join(dir, 'secrets.json');
  writeFileSync(file, '{"token:a":"');
  const app = await launch(dir);
  const win = await app.firstWindow();
  await expect(win.getByTestId('settings-form')).toBeVisible();
  const r = await win.evaluate(() => (window as any).viewedDesktop.setSecret('token:b', 'B').then(() => 'ok', () => 'rejected'));
  expect(r).toBe('rejected');
  expect(readFileSync(file, 'utf8')).toBe('{"token:a":"');
  expect(existsSync(file + '.tmp')).toBe(false);
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
