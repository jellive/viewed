import type { GitHub } from './github';
import type { Snapshot } from './types';

export async function loadSnapshot(gh: GitHub, owner: string, repo: string, branch: string, base?: string): Promise<Snapshot> {
  const b = base ?? (await gh.defaultBranch(owner, repo));
  const headSha = await gh.branchHead(owner, repo, branch);   // 스냅샷 고정 (spec §5.1)
  const { files, truncated, mergeBase } = await gh.compare(owner, repo, b, headSha);
  const { modes } = await gh.treeModes(owner, repo, headSha);
  // tree 가 잘리면 일부 파일의 mode 가 비고, 그 축은 지문에서 빠진다(spec §5.2)
  return { owner, repo, base: b, branch, headSha, truncated, mergeBase,
    files: files.map((f) => ({ ...f, mode: modes.get(f.path) })) };
}
