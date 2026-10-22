import type { ChangedFile, FileStatus, Snapshot } from './types';

// 데스크톱 main 이 정해진 git 명령만 실행해 출력 문자열을 돌려준다. 인자는 전부 커밋 해시이거나 전체 ref 이름
export interface LocalGit {
  resolve(ref: string): Promise<string>;              // rev-parse --verify <ref>^{commit}
  mergeBase(a: string, b: string): Promise<string>;
  rawDiff(a: string, b: string): Promise<string>;     // diff -M --no-abbrev --raw -z
  patchDiff(a: string, b: string): Promise<string>;   // diff -M --no-abbrev -p -U3 (같은 -M 이라 같은 순서)
}

const STATUS: Record<string, FileStatus> = { A: 'added', D: 'removed', M: 'modified', T: 'changed', R: 'renamed', C: 'copied' };
const ZERO = /^0+$/;

interface RawEntry { status: FileStatus; path: string; previousPath?: string; newMode: string; newOid: string }

// ":<old mode> <new mode> <old oid> <new oid> <status><score>\0<path>\0[<path2>\0]"
function parseRawZ(out: string): RawEntry[] {
  const t = out.split('\0');
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < t.length && t[i] !== '') {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(t[i]);
    if (!m) throw new Error(`unexpected git raw record: ${t[i].slice(0, 80)}`);
    const status = STATUS[m[5]];
    if (!status) throw new Error(`unsupported git status ${m[5]}`);
    const two = m[5] === 'R' || m[5] === 'C';
    const src = t[i + 1], dst = two ? t[i + 2] : src;
    if (src === undefined || dst === undefined) throw new Error('truncated git raw output');
    entries.push({ status, path: dst, previousPath: two ? src : undefined, newMode: m[2], newOid: m[4] });
    i += two ? 3 : 2;
  }
  return entries;
}

// 파일마다 "diff --git " 줄로 시작한다. 내용 줄은 ' ', '+', '-', '\' 로 시작하므로 경계와 헷갈리지 않는다
function splitSections(out: string): string[][] {
  const sections: string[][] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) sections.push([]);
    else if (sections.length) sections[sections.length - 1].push(line);
  }
  return sections;
}

// GitHub patch 와 같은 꼴: 머리를 떼고 첫 hunk 부터, 끝 개행 없이. hunk 가 없거나 바이너리면 undefined
function hunks(section: string[]): string | undefined {
  const at = section.findIndex((l) => l.startsWith('@@ '));
  if (at < 0) return undefined;
  const body = section.slice(at);
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}

// from..head 사이의 변경 파일. 둘 다 커밋 해시다
export async function loadLocalRange(git: LocalGit, from: string, head: string): Promise<ChangedFile[]> {
  const [raw, patch] = await Promise.all([git.rawDiff(from, head), git.patchDiff(from, head)]);
  const entries = parseRawZ(raw);
  const sections = splitSections(patch);
  // 종류 변경(파일↔심볼릭 링크 등, T)은 raw 에선 한 줄인데 patch 에선 삭제+추가 두 섹션이다
  const want = entries.reduce((n, e) => n + (e.status === 'changed' ? 2 : 1), 0);
  if (sections.length !== want) throw new Error(`git patch sections (${sections.length}) don't match changed files (${want})`);
  let at = 0;
  return entries.map((e) => {
    const removed = e.status === 'removed' || ZERO.test(e.newOid);
    const section = sections[at];
    at += e.status === 'changed' ? 2 : 1;
    // 서브모듈(160000)은 내용이 아니라 커밋 해시, 종류 변경은 두 덩어리라 diff 를 안 보인다(지문은 mode·blob 으로 갈린다)
    const patchText = e.newMode === '160000' || e.status === 'changed' ? undefined : hunks(section);
    return {
      path: e.path,
      ...(e.previousPath !== undefined ? { previousPath: e.previousPath } : {}),
      status: e.status,
      blobSha: removed ? null : e.newOid,
      ...(patchText !== undefined ? { patch: patchText } : {}),
      mode: removed ? undefined : e.newMode,
    };
  });
}

export async function loadLocalSnapshot(git: LocalGit, repoId: string, branchRef: string, baseRef: string): Promise<Snapshot> {
  // 처음에 해시로 고정하고 이후 명령은 해시만 쓴다 — 도중에 브랜치가 움직여도 섞이지 않는다
  const head = await git.resolve(branchRef);
  const base = await git.resolve(baseRef);
  const mb = await git.mergeBase(base, head);
  const files = await loadLocalRange(git, mb, head);
  return { owner: 'local', repo: repoId, base: baseRef, branch: branchRef, headSha: head, files, truncated: false, mergeBase: mb };
}

// 체크 기록의 레포 이름. 원격이 있으면 host/owner/repo, 없으면 폴더 전체 경로. 로컬 모드는 owner 가 'local' 이라 GitHub 모드 기록과 섞이지 않는다
export function repoIdFromRemote(url: string | null, folder: string): string {
  if (url) {
    const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url);
    let host = '', path = '';
    if (scp) { host = scp[1]; path = scp[2]; }
    else {
      try { const u = new URL(url); host = u.hostname; path = u.pathname; } catch { /* 아래 폴더 이름으로 */ }
    }
    path = path.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
    if (host && path) return `${host}/${path}`.toLowerCase();
  }
  // 원격이 없으면 전체 경로 — 이름만 같은 다른 폴더와 기록이 섞이지 않게(대소문자도 그대로)
  return `folder:${folder}`;
}
