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
}
export interface ViewRecord { fp: string; blob: string | null; head: string; at: string; viewed: boolean }
export type DeviceState = Record<string, ViewRecord>;   // 키 = HMAC hex
export type FileState = 'viewed' | 'unread' | 'changed-since-viewed';
export interface ReviewItem { file: ChangedFile; key: string; fp: string; state: FileState; record?: ViewRecord }
export interface Review { items: ReviewItem[]; viewedCount: number; total: number; incomplete: boolean; complete: boolean }
