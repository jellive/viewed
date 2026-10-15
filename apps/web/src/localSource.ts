import type { LocalGit } from '@viewed/core';

export const desktopGit = () => window.viewedDesktop?.git;

// IPC 브리지를 core 의 LocalGit 모양으로
export function localGit(repo: string): LocalGit {
  const g = desktopGit()!;
  const s = async (p: Promise<string | null>) => (await p) ?? '';
  return {
    resolve: (ref) => s(g.run(repo, 'resolve', ref)),
    mergeBase: (a, b) => s(g.run(repo, 'mergeBase', a, b)),
    rawDiff: (a, b) => s(g.run(repo, 'rawDiff', a, b)),
    patchDiff: (a, b) => s(g.run(repo, 'patchDiff', a, b)),
  };
}

export const localBlob = (repo: string) => (sha: string) => desktopGit()!.run(repo, 'blob', sha);

// refs/heads/feat → feat, refs/remotes/origin/main → origin/main
export const shortRef = (r: string) => r.replace(/^refs\/(heads|remotes)\//, '');
