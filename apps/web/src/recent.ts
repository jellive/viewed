// 마지막으로 연 것. 기기 전용 편의 기록이라 gist 로 보내지 않고, 깨지면 버린다(체크 기록과 무관)
export type Last =
  | { source: 'local'; repo: string; branch: string; base: string }
  | { source: 'github'; account: string; repo: string; branch: string; base: string };   // base 는 입력한 값 그대로(빈 값 = 기본 브랜치)
export type LocalReview = { repo: string; branch: string; base: string };
// localRepo: 마지막으로 연 로컬 레포 — GitHub 리뷰를 열어 last 가 바뀌어도 로컬로 돌아오면 이 레포부터
// history: 열기에 성공한 로컬 조합, 최근 것이 앞(최근 목록)
export interface Recent { last?: Last; local: Record<string, { branch: string; base: string }>; localRepo?: string; history: LocalReview[] }

const KEY = 'viewed.recent';
const MAX = 10;
const str = (v: unknown): v is string => typeof v === 'string';
const same = (a: LocalReview, b: LocalReview) => a.repo === b.repo && a.branch === b.branch && a.base === b.base;
// 겹치면 앞의 것 하나만, 최대 10개
const tidy = (l: LocalReview[]) => l.filter((h, i) => l.findIndex((g) => same(g, h)) === i).slice(0, MAX);

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
    // history 전에 쓴 기록은 레포별 마지막 조합에서 시작한다 — 마지막 것, 마지막 로컬 레포, 나머지 순. 빈 배열은 비운 그대로
    const h: unknown = v?.history;
    const history = Array.isArray(h)
      ? h.flatMap((e) => {
        const { repo, branch, base } = (e ?? {}) as Record<string, unknown>;
        return str(repo) && str(branch) && str(base) ? [{ repo, branch, base }] : [];
      })
      : [...(last?.source === 'local' ? [{ repo: last.repo, branch: last.branch, base: last.base }] : []),
        ...(localRepo !== undefined && local[localRepo] ? [{ repo: localRepo, ...local[localRepo] }] : []),
        ...Object.entries(local).map(([repo, m]) => ({ repo, ...m }))];
    return { last, local, ...(localRepo !== undefined ? { localRepo } : {}), history: tidy(history) };
  } catch { return { local: {}, history: [] }; }
}

// 열기가 성공했을 때 그 요청의 값으로 부른다. 실패는 삼킨다 — 리뷰는 열렸는데 오류가 뜨지 않게
function write(f: (r: Recent) => Recent) {
  try { localStorage.setItem(KEY, JSON.stringify(f(readRecent()))); } catch { /* 다음 열기에서 다시 쓴다 */ }
}
export const rememberLocal = (repo: string, branch: string, base: string) =>
  write((r) => ({ last: { source: 'local', repo, branch, base }, local: { ...r.local, [repo]: { branch, base } }, localRepo: repo, history: tidy([{ repo, branch, base }, ...r.history]) }));
export const rememberGithub = (account: string, repo: string, branch: string, base: string) =>
  write((r) => ({ ...r, last: { source: 'github', account, repo, branch, base } }));
// 브랜치·base 가 지워져 확실히 못 여는 조합만 최근 목록에서 뺀다
export const dropRecent = (h: LocalReview) => write((r) => ({ ...r, history: r.history.filter((g) => !same(g, h)) }));
