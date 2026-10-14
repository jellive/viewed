import type { Page } from '@playwright/test';
import { fingerprint, recordKey, type FileStatus } from '@viewed/core';

export interface MockFile { filename: string; status: string; sha: string; patch?: string; previous_filename?: string }
export interface MockOpts {
  head?: string;
  files: MockFile[];
  modes?: Record<string, string>;
  blobs?: Record<string, string>;            // 없는 sha 는 404
  gistFiles?: Record<string, string>;        // 파일명 → content
}

export async function mockGitHub(page: Page, o: MockOpts) {
  const gistPatches: unknown[] = [];
  const head = o.head ?? 'h1';
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/repos/acme/widget') return json({ default_branch: 'main' });
    if (p === '/repos/acme/widget/branches/feat') return json({ commit: { sha: head } });
    if (p === `/repos/acme/widget/compare/main...${head}`) return json({ files: o.files });
    if (p === `/repos/acme/widget/git/trees/${head}`)
      return json({ truncated: false, tree: o.files.map((f) => ({ path: f.filename, type: 'blob', mode: o.modes?.[f.filename] ?? '100644' })) });
    const blob = p.match(/^\/repos\/acme\/widget\/git\/blobs\/(.+)$/);
    if (blob) return o.blobs?.[blob[1]] !== undefined ? route.fulfill({ status: 200, body: o.blobs[blob[1]] }) : json({ message: 'Not Found' }, 404);
    if (p === '/gists/g1' && req.method() === 'PATCH') { gistPatches.push(req.postDataJSON()); return json({}); }
    if (p === '/gists/g1')
      return json({ files: Object.fromEntries(Object.entries(o.gistFiles ?? {}).map(([n, c]) => [n, { content: c, truncated: false, raw_url: '' }])) });
    return json({ message: `unmocked ${p}` }, 500);
  });
  return { gistPatches };
}

export const SETTINGS = { accounts: [{ label: 'personal', token: 'tok' }], gistAccount: 'personal', gistId: 'g1', secret: 's3cret', deviceId: 'mac' };

// 주어진 파일들을 '이미 봤음'으로 기록한 gist 내용 — 앱과 같은 core 함수로 키·지문을 만든다
export async function viewedGist(files: MockFile[], at = '2026-10-15T00:00:00Z') {
  const state: Record<string, unknown> = {};
  for (const f of files) {
    const key = await recordKey(SETTINGS.secret, 'acme', 'widget', 'feat', f.filename);
    const fp = await fingerprint({
      path: f.filename, previousPath: f.previous_filename, status: f.status as FileStatus,
      blobSha: f.status === 'removed' ? null : f.sha, ...(f.patch !== undefined ? { patch: f.patch } : {}), mode: '100644',
    });
    state[key] = { fp, blob: f.sha, head: 'h1', at, viewed: true };
  }
  return { [`device-${SETTINGS.deviceId}.json`]: JSON.stringify(state) };
}

export async function seedSettings(page: Page) {
  await page.addInitScript((s) => localStorage.setItem('viewed.settings', JSON.stringify(s)), SETTINGS);
}
