import { fileContextPatch, type Author, type ChangedFile, type LocalGit } from '@viewed/core';

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

// 파일 하나를 안 바뀐 줄까지 전부 읽는다. 읽을 hunk 가 없으면 던진다 — 화면은 원래 diff 를 그대로 둔다
export async function localFileContext(repo: string, mergeBase: string, head: string, file: ChangedFile): Promise<string> {
  const patch = fileContextPatch((await desktopGit()!.run(repo, 'fileDiff', mergeBase, head, file.path, file.previousPath)) ?? '');
  if (patch === undefined) throw new Error('no hunks');
  return patch;
}

// refs/heads/feat → feat, refs/remotes/origin/main → origin/main
export const shortRef = (r: string) => r.replace(/^refs\/(heads|remotes)\//, '');

// 파일별 작성자 + 이름 변경 쌍. 실패·파싱 오류는 null — 못 읽었으면 전부 내 것으로 둔다(흐리지 않는다)
export async function localAuthors(repo: string, mergeBase: string, head: string): Promise<{ files: Record<string, Author[]>; renames: [string, string][] } | null> {
  try {
    const raw = await desktopGit()!.run(repo, 'authors', mergeBase, head);
    if (!raw) return null;
    const j = JSON.parse(raw) as { files?: unknown; renames?: unknown };
    const pair = (x: unknown) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string';
    if (!j || typeof j.files !== 'object' || j.files === null || Array.isArray(j.files)) return null;
    for (const v of Object.values(j.files)) if (!Array.isArray(v) || !v.every(pair)) return null;
    if (!Array.isArray(j.renames) || !j.renames.every(pair)) return null;
    return { files: j.files as Record<string, Author[]>, renames: j.renames as [string, string][] };
  } catch { return null; }
}

// head 의 줄마다 작성자 두 벌 — 인덱스 n-1 이 head 줄 n. plain = 그대로, moved = 공백 무시·이동 추적. 경계·merge-base 이전 줄은 null.
// 실패·파싱 오류도 null(색을 안 입힌다)
export type LineBlame = { plain: (Author | null)[]; moved: (Author | null)[] };
export async function localBlame(repo: string, head: string, path: string, mergeBase: string): Promise<LineBlame | null> {
  try {
    const raw = await desktopGit()!.run(repo, 'blameAuthors', head, path, mergeBase);
    if (!raw) return null;
    const j = JSON.parse(raw) as { plain?: unknown; moved?: unknown } | null;
    const pair = (x: unknown) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string';
    const col = (v: unknown) => Array.isArray(v) && v.every((x) => x === null || pair(x));
    if (!j || !col(j.plain) || !col(j.moved) || (j.plain as unknown[]).length !== (j.moved as unknown[]).length) return null;
    return { plain: j.plain as (Author | null)[], moved: j.moved as (Author | null)[] };
  } catch { return null; }
}
