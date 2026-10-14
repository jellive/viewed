import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('loads the web build and stores secrets encrypted', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'viewed-'));
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: join(__dirname, '..') });
  const win = await app.firstWindow();
  await expect(win).toHaveTitle('viewed');
  await expect(win.getByTestId('settings-form')).toBeVisible();
  await win.evaluate(() => (window as any).viewedDesktop!.setSecret('token:personal', 'plain-token-123'));
  expect(await win.evaluate(() => (window as any).viewedDesktop!.getSecret('token:personal'))).toBe('plain-token-123');
  const onDisk = readFileSync(join(userData, 'secrets.json'), 'utf8');
  expect(onDisk).not.toContain('plain-token-123');
  const stored = JSON.parse(onDisk)['token:personal'] as string;
  expect(Buffer.from(stored, 'base64').toString('utf8')).not.toBe('plain-token-123');
  const dec = await app.evaluate(async ({ safeStorage }, b64) => {
    const out: any = await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'));
    return typeof out === 'string' ? out : out.result;
  }, stored);
  expect(dec).toBe('plain-token-123');
  expect(await win.evaluate(() => (window as any).viewedDesktop!.getSecret('missing'))).toBeNull();
  await app.close();
});
