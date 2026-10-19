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
export interface ViewRecord { fp: string; blob: string | null; head: string; at: string; viewed: boolean; blocks?: string[]; base?: string; meta?: string }
export type DeviceState = Record<string, ViewRecord>;   // 키 = HMAC hex
export type FileState = 'viewed' | 'unread' | 'changed-since-viewed';
// newBlocks: 확인한 블록과 안 맞는 지금 블록 번호 / carried: 지문은 바뀌었지만 블록이 전부 확인한 것이라 확인함
export interface ReviewItem {
  file: ChangedFile; key: string; fp: string; meta: string; blocks?: string[]; base?: string;
  state: FileState; record?: ViewRecord; newBlocks?: number[]; carried?: boolean;
}
export interface Review { items: ReviewItem[]; viewedCount: number; total: number; incomplete: boolean; complete: boolean }
