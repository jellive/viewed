// 마지막으로 연 것. 기기 전용 편의 기록이라 gist 로 보내지 않고, 깨지면 버린다(체크 기록과 무관)
export type Last =
  | { source: 'local'; repo: string; branch: string; base: string }
  | { source: 'github'; account: string; repo: string; branch: string; base: string };   // base 는 입력한 값 그대로(빈 값 = 기본 브랜치)
// localRepo: 마지막으로 연 로컬 레포 — GitHub 리뷰를 열어 last 가 바뀌어도 로컬로 돌아오면 이 레포부터
export interface Recent { last?: Last; local: Record<string, { branch: string; base: string }>; localRepo?: string }

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
    // 이 필드 전에 쓴 기록은 last 가 로컬이면 그 레포가 곧 마지막 로컬 레포다
    const lr: unknown = v?.localRepo;
    const localRepo = str(lr) ? lr : last?.source === 'local' ? last.repo : undefined;
    return { last, local, ...(localRepo !== undefined ? { localRepo } : {}) };
  } catch { return { local: {} }; }
}

// 열기가 성공했을 때 그 요청의 값으로 부른다. 실패는 삼킨다 — 리뷰는 열렸는데 오류가 뜨지 않게
function write(f: (r: Recent) => Recent) {
  try { localStorage.setItem(KEY, JSON.stringify(f(readRecent()))); } catch { /* 다음 열기에서 다시 쓴다 */ }
}
export const rememberLocal = (repo: string, branch: string, base: string) =>
  write((r) => ({ last: { source: 'local', repo, branch, base }, local: { ...r.local, [repo]: { branch, base } }, localRepo: repo }));
export const rememberGithub = (account: string, repo: string, branch: string, base: string) =>
  write((r) => ({ ...r, last: { source: 'github', account, repo, branch, base } }));
