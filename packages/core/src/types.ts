export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  blobSha: string | null;   // removed 면 null
  patch?: string;           // 바이너리·대용량이면 없음
  mode?: string;            // tree 에서 채움, 없으면 undefined
}
export interface Snapshot {
  owner: string; repo: string; base: string; branch: string;
  headSha: string; files: ChangedFile[]; truncated: boolean;
  mergeBase?: string;   // base 와 브랜치의 갈래점 — 기록의 base 와 같으면 base 가 안 움직인 것
}
// blocks·base·meta: 확인할 때의 변경 블록 서명·merge-base·meta (spec §4). 이 기능 전 기록에는 없다
export interface ViewRecord { fp: string; blob: string | null; head: string; at: string; viewed: boolean; blocks?: string[]; base?: string; meta?: string;
  prev?: { base: string; fp: string } }   // 대상 전환 이어받기(b)로 쓴 기록만: 이전 대상 P 에서 확인했던 base·지문. P 로 돌아가면 그대로 확인함으로 본다
export type DeviceState = Record<string, ViewRecord>;   // 키 = HMAC hex
export type FileState = 'viewed' | 'unread' | 'changed-since-viewed';
// newBlocks: 확인한 블록과 안 맞는 지금 블록 번호 / carried: 지문은 바뀌었지만 블록이 전부 확인한 것이라 확인함
// ('same' = 확인한 블록이 전부 남음, 'shrunk' = 일부가 diff 에서 사라짐 — dropped 는 그 개수)
export interface ReviewItem {
  file: ChangedFile; key: string; fp: string; meta: string; blocks?: string[]; base?: string;
  state: FileState; record?: ViewRecord; newBlocks?: number[]; carried?: 'same' | 'shrunk'; dropped?: number;
  carryPrev?: { base: string; fp: string };   // targetCarry 가 (b) 로 고른 item 에만: 이어받기 전 기록의 base·지문
  others?: string[];   // 남의 커밋만 닿은 파일이라 확인한 것으로 친다 — 남 작성자 이름
  elsewhere?: true;    // 기록이 없고 다른 브랜치에서 확인한 블록과 일부 겹친다 — newBlocks 만 보인다. 저장하지 않는다
}
export interface Review { items: ReviewItem[]; viewedCount: number; total: number; incomplete: boolean; complete: boolean }
// 기록의 옛 merge-base → to(지금 merge-base) 사이 트리에서 바뀐 경로. null = 못 쟀다(git 실패·시간 초과)
export interface BaseMoves { to: string; from: ReadonlyMap<string, ReadonlySet<string> | null> }
