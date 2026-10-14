import { test, expect } from '@playwright/test';

test('serves a manifest and registers a service worker', async ({ page, request }) => {
  const m = await request.get('/manifest.webmanifest');
  expect(m.ok()).toBe(true);
  expect((await m.json()).name).toBe('viewed');
  await page.goto('/');
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBeGreaterThan(0);
});

test('CSP blocks requests to other hosts', async ({ page }) => {
  await page.goto('/');
  // fetch 실패만 보면 CORS·네트워크 오류로도 통과한다 — CSP 위반 이벤트 자체를 확인한다
  const v = await page.evaluate(() => new Promise<{ uri: string; dir: string }>((res) => {
    document.addEventListener('securitypolicyviolation', (e) => res({ uri: e.blockedURI, dir: e.effectiveDirective }), { once: true });
    fetch('https://example.com/x').catch(() => {});
  }));
  expect(v.dir).toBe('connect-src');
  expect(v.uri).toContain('example.com');
});
