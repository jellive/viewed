export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  blobSha: string | null;   // removed 면 null
  patch?: string;           // 바이너리·대용량이면 없음
  mode?: string;            // tree 에서 채움, 없으면 undefined
  oldMode?: string;         // 로컬 모드만: base 쪽 mode. 지문에 안 든다
}
export interface Snapshot {
  owner: string; repo: string; base: string; branch: string;
  headSha: string; files: ChangedFile[]; truncated: boolean;
  mergeBase?: string;   // base 와 브랜치의 갈래점 — 기록의 base 와 같으면 base 가 안 움직인 것
}
// blocks·base·meta: 확인할 때의 변경 블록 서명·merge-base·meta (spec §4). 이 기능 전 기록에는 없다
export interface ViewRecord { fp: string; blob: string | null; head: string; at: string; viewed: boolean; blocks?: string[]; base?: string; meta?: string;
  prev?: { base: string; fp: string; via?: 'branch' | 'target' };   // via:'target' 기록만: 사람이 실제로 본 diff 의 base·지문·출처. 대상을 몇 번 옮겨도 덮지 않는다. P 로 돌아가면 그때 그대로다
  via?: 'branch' | 'target';             // 사람이 안 누르고 앱이 이어받아 쓴 기록 — 다른 브랜치·이전 대상에서. 이 필드 전 기록은 직접 체크로 읽힌다
  oldMode?: string }                     // 확인할 때 base 쪽 mode(로컬 모드만). 이 필드 전 기록에는 없다
export type DeviceState = Record<string, ViewRecord>;   // 키 = HMAC hex
export type FileState = 'viewed' | 'unread' | 'changed-since-viewed';
// newBlocks: 확인한 블록과 안 맞는 지금 블록 번호 / carried: 지문은 바뀌었지만 블록이 전부 확인한 것이라 확인함
// ('same' = 확인한 블록이 전부 남음, 'shrunk' = 일부가 diff 에서 사라짐 — dropped 는 그 개수)
export interface ReviewItem {
  file: ChangedFile; key: string; fp: string; meta: string; blocks?: string[]; base?: string;
  state: FileState; record?: ViewRecord; newBlocks?: number[]; carried?: 'same' | 'shrunk'; dropped?: number;
  carryPrev?: { base: string; fp: string; via?: 'branch' | 'target' };   // 대상 전환 이어받기 중 옛 대상에서 본 diff 가 확인된 item 에만(targetCarry (b)·sameResultCarry): 이어받기 전 기록의 base·지문·출처
  carryVia?: 'target'; // 다른 브랜치에서 이어받을 때 그쪽 기록도 이어받은 것이었다 — 사람이 본 근거로 승격하지 않게 출처를 넘긴다
  others?: string[];   // 남의 커밋만 닿은 파일이라 확인한 것으로 친다 — 남 작성자 이름
  elsewhere?: true;    // 기록이 없고 다른 브랜치에서 확인한 것과 겹친다 — newBlocks 나 seenBlob 이후 바뀐 줄만 보인다. 저장하지 않는다
  seenBlob?: string;   // elsewhere 중 양쪽 다 새 파일일 때: 거기서 확인한 blob. 블록 하나짜리라 줄 단위로 비교한다
  newLines?: number[]; // 결과 파일이 그때 본 것과 같을 때 처음 보는 변경 줄 — patch 를 \n 으로 나눈 번호. 저장하지 않는다
  auto?: true;         // 확인함인데 사람이 이 기록을 누른 게 아니다 — 남의 파일이거나 이어받은 기록
  carriedOver?: true;  // auto 중 이어받은 기록 쪽 — 남의 파일이면 오래된 기록이 있어도 아니다
}
// 다른 브랜치에서 확인한 것 — 변경 블록, 또는 양쪽 다 새 파일이면 그때의 blob
export type NearMatch = { blocks: string[] } | { blob: string };
// 경로 → 처음 보는 변경 줄. fp = 그 줄을 잴 때의 이 파일 지문 — 새 커밋으로 diff 가 바뀌면 줄 번호가 안 맞으니 안 쓴다
export type NewLines = ReadonlyMap<string, { fp: string; lines: number[] }>;
export interface Review { items: ReviewItem[]; viewedCount: number; autoCount: number; total: number; incomplete: boolean; complete: boolean }
// 기록의 옛 merge-base → to(지금 merge-base) 사이 트리에서 바뀐 경로. null = 못 쟀다(git 실패·시간 초과)
export interface BaseMoves { to: string; from: ReadonlyMap<string, ReadonlySet<string> | null> }
