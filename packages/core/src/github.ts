import type { ChangedFile, FileStatus } from './types';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class GitHub {
  constructor(
    private token: string,
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private apiBase = 'https://api.github.com',
  ) {}

  private async req(path: string, init: RequestInit = {}, accept = 'application/vnd.github+json'): Promise<Response> {
    const res = await this.fetchImpl(this.apiBase + path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept,
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!res.ok) throw new GitHubError(res.status, `${res.status} ${path}`);
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.req(path, init)).json() as Promise<T>;
  }

  async branchHead(owner: string, repo: string, branch: string): Promise<string> {
    const b = await this.json<{ commit: { sha: string } }>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    return b.commit.sha;
  }

  async defaultBranch(owner: string, repo: string): Promise<string> {
    return (await this.json<{ default_branch: string }>(`/repos/${owner}/${repo}`)).default_branch;
  }

  async compare(owner: string, repo: string, base: string, headSha: string) {
    type F = { filename: string; previous_filename?: string; status: FileStatus; sha: string; patch?: string };
    const body = await this.json<{ files?: F[] }>(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${headSha}`);
    const raw = body.files ?? [];
    const files: ChangedFile[] = raw.map((x) => ({
      path: x.filename,
      previousPath: x.previous_filename,
      status: x.status,
      blobSha: x.status === 'removed' ? null : x.sha,
      ...(x.patch !== undefined ? { patch: x.patch } : {}),
    }));
    // GitHub 은 300개에서 자르고, 정확히 300개와 잘림을 구분할 수 없다 (spec §5.1)
    return { files, truncated: raw.length >= 300 };
  }

  async treeModes(owner: string, repo: string, headSha: string) {
    const t = await this.json<{ truncated: boolean; tree: { path: string; mode: string; type: string }[] }>(
      `/repos/${owner}/${repo}/git/trees/${headSha}?recursive=1`);
    const modes = new Map<string, string>();
    for (const e of t.tree) if (e.type === 'blob' || e.type === 'commit') modes.set(e.path, e.mode);
    return { modes, truncated: t.truncated };
  }

  async blobText(owner: string, repo: string, sha: string): Promise<string | null> {
    try {
      return await (await this.req(`/repos/${owner}/${repo}/git/blobs/${sha}`, {}, 'application/vnd.github.raw+json')).text();
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  getGist(id: string) {
    return this.json<{ truncated?: boolean; files: Record<string, { content: string; truncated: boolean; raw_url: string }> }>(`/gists/${id}`);
  }

  async updateGistFile(id: string, name: string, content: string): Promise<void> {
    await this.req(`/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: { [name]: { content } } }) });
  }

  async fetchRaw(url: string): Promise<string> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new GitHubError(res.status, `${res.status} raw`);
    return res.text();
  }
}
