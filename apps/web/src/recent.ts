// 마지막으로 연 것. 기기 전용 편의 기록이라 gist 로 보내지 않고, 깨지면 버린다(체크 기록과 무관)
export type Last =
  | { source: 'local'; repo: string; branch: string; base: string }
  | { source: 'github'; account: string; repo: string; branch: string; base: string };   // base 는 입력한 값 그대로(빈 값 = 기본 브랜치)
export interface Recent { last?: Last; local: Record<string, { branch: string; base: string }> }

const KEY = 'viewed.recent';
const str = (v: unknown): v is string => typeof v === 'string';

export function readRecent(): Recent {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const local: Recent['local'] = {};
    for (const [repo, m] of Object.entries(v?.local ?? {})) {
      const { branch, base } = (m ?? {}) as Record<string, unknown>;
      if (str(branch) && str(base)) local[repo] = { branch, base };
    }
    const { source, account, repo, branch, base } = (v?.last ?? {}) as Record<string, unknown>;
    const ok = str(repo) && str(branch) && str(base);
    const last: Last | undefined = ok && source === 'local' ? { source, repo, branch, base }
      : ok && source === 'github' && str(account) ? { source, account, repo, branch, base } : undefined;
    return { last, local };
  } catch { return { local: {} }; }
}

// 열기가 성공했을 때 그 요청의 값으로 부른다. 실패는 삼킨다 — 리뷰는 열렸는데 오류가 뜨지 않게
function write(f: (r: Recent) => Recent) {
  try { localStorage.setItem(KEY, JSON.stringify(f(readRecent()))); } catch { /* 다음 열기에서 다시 쓴다 */ }
}
export const rememberLocal = (repo: string, branch: string, base: string) =>
  write((r) => ({ last: { source: 'local', repo, branch, base }, local: { ...r.local, [repo]: { branch, base } } }));
export const rememberGithub = (account: string, repo: string, branch: string, base: string) =>
  write((r) => ({ ...r, last: { source: 'github', account, repo, branch, base } }));
