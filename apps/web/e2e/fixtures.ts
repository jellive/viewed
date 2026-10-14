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

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GistHooks {
  id?: string;                               // gist id (기본 g1)
  initial?: Record<string, string>;
  // 요청 n 번째 PATCH — 기다린 뒤 상태코드를 돌려주면 실패로 응답한다. 성공이면 도착 후에 저장소에 반영
  patch?: (n: number, body: { files: Record<string, { content: string }> }) => Promise<number | 'abort' | void>;
  // n 번째 GET — 요청이 도착한 시점의 저장소를 찍어 두고, 기다린 뒤 그 (낡은) 사본을 돌려준다
  get?: (n: number) => Promise<void>;
}

// 상태가 있는 gist 모의: PATCH 는 저장, GET 은 저장된 것을 돌려준다. mockGitHub 다음에 호출해야 이쪽이 우선한다
export async function statefulGist(page: Page, h: GistHooks = {}) {
  const store: Record<string, string> = { ...(h.initial ?? {}) };
  const patches: { files: Record<string, { content: string }> }[] = [];
  let nPatch = 0, nGet = 0;
  await page.route(`https://api.github.com/gists/${h.id ?? 'g1'}`, async (route) => {
    const req = route.request();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'PATCH') {
      const n = nPatch++;
      const body = req.postDataJSON();
      patches.push(body);
      const fail = await h.patch?.(n, body);
      if (fail === 'abort') return route.abort();
      if (typeof fail === 'number') return json({}, fail);
      for (const [name, f] of Object.entries(body.files as Record<string, { content: string }>)) store[name] = f.content;
      return json({});
    }
    const n = nGet++;
    const snap = { ...store };
    await h.get?.(n);
    return json({ files: Object.fromEntries(Object.entries(snap).map(([k, c]) => [k, { content: c, truncated: false, raw_url: '' }])) });
  });
  const deviceKeys = () => Object.keys(JSON.parse(store['device-mac.json'] ?? '{}'));
  return { store, patches, deviceKeys };
}

// 다른 브랜치 — mockGitHub 다음에 호출
export async function mockBranch(page: Page, branch: string, head: string, files: MockFile[]) {
  await page.route('https://api.github.com/repos/acme/widget/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === `/repos/acme/widget/branches/${branch}`) return json({ commit: { sha: head } });
    if (p === `/repos/acme/widget/compare/main...${head}`) return json({ files });
    if (p === `/repos/acme/widget/git/trees/${head}`) return json({ truncated: false, tree: files.map((f) => ({ path: f.filename, type: 'blob', mode: '100644' })) });
    return route.fallback();
  });
}
