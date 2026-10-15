import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  webServer: { command: 'pnpm build && pnpm preview', port: 4173, reuseExistingServer: false },
  use: { baseURL: 'http://localhost:4173', locale: 'en-US' },   // 기존 스펙은 영어 문구로 단언한다
});
