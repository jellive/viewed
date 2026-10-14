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

test('built service worker takes over immediately on update', async () => {
  const { readFileSync } = await import('node:fs');
  const sw = readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8');
  // 새 SW 가 waiting 에 머물면 배포 뒤에도 옛 프리캐시가 계속 나간다
  // 기본값은 메시지('SKIP_WAITING') 핸들러 안에서만 skipWaiting() 을 부른다 — 무조건 호출이어야 한다
  expect(sw).not.toMatch(/addEventListener\("message"/);
  expect(sw).toMatch(/skipWaiting\(\)/);
  expect(sw).toMatch(/clientsClaim\(\)/);
});
