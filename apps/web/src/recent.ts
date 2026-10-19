// 마지막으로 연 것. 기기 전용 편의 기록이라 gist 로 보내지 않고, 깨지면 버린다(체크 기록과 무관)
export interface Recent { local: Record<string, { branch: string; base: string }> }

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
    return { local };
  } catch { return { local: {} }; }
}

// 열기가 성공했을 때 그 요청의 값으로 부른다. 실패는 삼킨다 — 리뷰는 열렸는데 오류가 뜨지 않게
export function rememberLocal(repo: string, branch: string, base: string) {
  try {
    const r = readRecent();
    localStorage.setItem(KEY, JSON.stringify({ ...r, local: { ...r.local, [repo]: { branch, base } } }));
  } catch { /* 다음 열기에서 다시 쓴다 */ }
}
