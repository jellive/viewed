import { describe, it, expect } from 'vitest';
import { GitHub, GitHubError, type FetchLike } from '../src/github';

function fake(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([k]) => url.endsWith(k));
    if (!hit) return new Response('not found', { status: 404 });
    const { status = 200, body } = hit[1];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { f, calls };
}

describe('GitHub', () => {
  it('sends the token and api version headers', async () => {
    const { f, calls } = fake({ '/repos/acme/widget/branches/feat': { body: { commit: { sha: 'h1' } } } });
    await new GitHub('tok', f).branchHead('acme', 'widget', 'feat');
    const h = new Headers(calls[0].init?.headers);
    expect(h.get('authorization')).toBe('Bearer tok');
    expect(h.get('x-github-api-version')).toBe('2022-11-28');
  });

  it('maps compare files and flags 300 as truncated', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified', sha: `s${i}`, patch: 'p' }));
    const { f } = fake({ '/compare/main...h1': { body: { files } } });
    const r = await new GitHub('t', f).compare('acme', 'widget', 'main', 'h1');
    expect(r.truncated).toBe(true);
    expect(r.files[0]).toEqual({ path: 'f0.ts', status: 'modified', blobSha: 's0', patch: 'p', previousPath: undefined });
  });

  it('keeps previous_filename, null blob for removed, no patch for binaries', async () => {
    const { f } = fake({ '/compare/main...h1': { body: { files: [
      { filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed', sha: 's1', patch: 'p' },
      { filename: 'gone.ts', status: 'removed', sha: 's2', patch: 'p' },
      { filename: 'img.png', status: 'added', sha: 's3' },
    ] } } });
    const r = await new GitHub('t', f).compare('acme', 'widget', 'main', 'h1');
    expect(r.truncated).toBe(false);
    expect(r.files[0].previousPath).toBe('a.ts');
    expect(r.files[1].blobSha).toBeNull();
    expect(r.files[2].patch).toBeUndefined();
  });

  it('reads tree modes', async () => {
    const { f } = fake({ '/git/trees/h1?recursive=1': { body: { truncated: false, tree: [
      { path: 'a.ts', mode: '100755', type: 'blob' }, { path: 'dir', mode: '040000', type: 'tree' },
    ] } } });
    const r = await new GitHub('t', f).treeModes('acme', 'widget', 'h1');
    expect(r.modes.get('a.ts')).toBe('100755');
    expect(r.modes.has('dir')).toBe(false);
  });

  it('returns null for a missing blob (force-pushed away)', async () => {
    const { f } = fake({});
    expect(await new GitHub('t', f).blobText('acme', 'widget', 'dead')).toBeNull();
  });

  it('rejects with GitHubError status 500 for a server error, not null', async () => {
    const { f } = fake({ '/git/blobs/b1': { status: 500, body: { message: 'boom' } } });
    const p = new GitHub('t', f).blobText('acme', 'widget', 'b1');
    await expect(p).rejects.toBeInstanceOf(GitHubError);
    await expect(new GitHub('t', f).blobText('acme', 'widget', 'b1')).rejects.toMatchObject({ status: 500 });
  });

  it('asks for the raw blob media type', async () => {
    const { f, calls } = fake({ '/git/blobs/b1': { body: 'hello\n' } });
    expect(await new GitHub('t', f).blobText('acme', 'widget', 'b1')).toBe('hello\n');
    expect(new Headers(calls[0].init?.headers).get('accept')).toBe('application/vnd.github.raw+json');
  });

  it('throws GitHubError with status on 401', async () => {
    const { f } = fake({ '/repos/acme/widget': { status: 401, body: { message: 'Bad credentials' } } });
    await expect(new GitHub('t', f).defaultBranch('acme', 'widget')).rejects.toMatchObject({ status: 401 });
    await expect(new GitHub('t', f).defaultBranch('acme', 'widget')).rejects.toBeInstanceOf(GitHubError);
  });

  it('keeps the failing request path in detail so the UI can say which call failed', async () => {
    const { f } = fake({ '/repos/acme/widget': { status: 404, body: {} } });
    await expect(new GitHub('t', f).defaultBranch('acme', 'widget')).rejects.toMatchObject({ status: 404, detail: '/repos/acme/widget' });
  });

  it('patches one gist file', async () => {
    const { f, calls } = fake({ '/gists/g1': { body: {} } });
    await new GitHub('t', f).updateGistFile('g1', 'device-mac.json', '{}');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ files: { 'device-mac.json': { content: '{}' } } });
  });
});

describe('request timeout', () => {
  const hangs: FetchLike = (_u, init) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(init.signal?.reason ?? new Error('aborted')));
  });
  it('a request that never answers rejects with GitHubError status 0', async () => {
    const err = await new GitHub('t', hangs, 'https://api.github.com', 20).updateGistFile('g', 'f.json', '{}').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(0);
  });
  it('the raw fetch times out the same way', async () => {
    const err = await new GitHub('t', hangs, 'https://api.github.com', 20).fetchRaw('https://x/raw').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(0);
  });
  it('a request that answers in time is untouched', async () => {
    const { f, calls } = fake({ '/repos/acme/widget': { body: { default_branch: 'main' } } });
    expect(await new GitHub('t', f, 'https://api.github.com', 20).defaultBranch('acme', 'widget')).toBe('main');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('GitHubError messages (F7)', () => {
  const run = (status: number) => new GitHub('t', async () => new Response('x', { status })).branchHead('acme', 'widget', 'feat').catch((e) => e as GitHubError);
  it('401 says the token was rejected', async () => {
    const e = await run(401);
    expect(e.message).toContain('Token rejected');
    expect(e.message).toContain('401');
  });
  it('403/404 say no access', async () => {
    expect((await run(403)).message).toContain('No access to this repository');
    expect((await run(404)).message).toContain('No access to this repository');
  });
});
