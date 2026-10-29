import { changedPaths } from '@viewed/core';
import { localGit } from './localSource';

// 로컬 모드: 기록의 옛 merge-base → 지금 merge-base 사이 바뀐 경로. 쌍마다 한 번만 묻는 것은 useReview 몫
export function makeMoves(repo: string): (from: string, to: string) => Promise<ReadonlySet<string>> {
  const git = localGit(repo);
  return (from, to) => changedPaths(git, from, to);
}
