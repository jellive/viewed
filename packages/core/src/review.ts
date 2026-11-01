import { fingerprint } from './fingerprint';
import { recordKey } from './keys';
import { blockSigs, metaSig, unmatchedBlocks } from './blocks';
import type { BaseMoves, ChangedFile, DeviceState, FileState, NearMatch, NewLines, Review, ReviewItem, Snapshot, ViewRecord } from './types';

// 서명은 patch 가 같으면 같다 — 지문(patch 포함)으로 기억해 체크할 때마다 다시 HMAC 하지 않는다
const sigCache = new Map<string, string[]>();
async function sigsFor(secret: string, fp: string, patch: string): Promise<string[]> {
  const k = `${secret}\0${fp}`;
  let s = sigCache.get(k);
  if (!s) {
    s = await blockSigs(secret, patch);
    if (sigCache.size > 5000) sigCache.clear();
    sigCache.set(k, s);
  }
  return s;
}

// 지문이 같아도 그때 본 것이 아닌 경우. base 가 같은데 blob 이 다르면 글자로 못 읽는 바이트가 바뀐 것이고(UTF-8 이 아니면 전부 같은 글자로 뭉개진다),
// 지운 바이너리는 지문이 비어 base 가 움직이면 옛 내용이 달라도 모른다. mode 는 unseenMode
function sameDiffHides(file: ChangedFile, r: ViewRecord, mergeBase: string | undefined): boolean {
  if (unseenMode(file, r, mergeBase)) return true;
  if (r.base && r.base === mergeBase && file.patch !== undefined && r.blob !== file.blobSha) return true;
  return file.patch === undefined && file.status === 'removed' && !!r.base && !!mergeBase && r.base !== mergeBase;
}

// base 가 from → to 로 움직이며 이 파일(이전 경로 포함)을 안 건드렸는지. 못 쟀거나 다른 to 를 두고 잰 근거면 false
function untouched(moves: BaseMoves | undefined, from: string, to: string, file: ChangedFile): boolean {
  const s = moves?.to === to ? moves.from.get(from) : undefined;
  return !!s && !s.has(file.path) && !(file.previousPath !== undefined && s.has(file.previousPath));
}

// 사람이 실제로 본 diff. via:'target' 기록의 지문·블록은 새 대상의 diff 라 옛 대상에 이미 있던 줄과 남의 변경이 든다 — 그때 본 것은 prev 에 있다.
// 없으면(옛 대상과 같아 이어받았을 뿐인 파일, 대상 정보가 없는 옛 기록) undefined. via:'branch' 는 사람이 본 diff 와 같거나 그 부분집합이다
export function seenBasis(r: ViewRecord): { base: string; fp: string; via?: 'branch' | 'target' } | undefined {
  if (r.via === 'target') return r.prev && r.prev.via !== 'target' ? r.prev : undefined;
  return r.base ? { base: r.base, fp: r.fp, ...(r.via ? { via: r.via } : {}) } : undefined;
}

// 지금 diff 에 그때 못 본 mode 변경이 있나. 지문·블록은 결과 mode 만 알아 대상의 실행 권한을 없애는 변경을 모른다.
// base 가 그대로면 왼쪽 트리가 같으니 같은 변경이다. 새 파일·지운 파일은 상태가 말해 준다. 로컬 모드만 안다(oldMode)
export function unseenMode(file: ChangedFile, r: ViewRecord, mergeBase: string | undefined): boolean {
  if (file.oldMode === undefined || file.status === 'added' || file.status === 'removed' || file.oldMode === file.mode) return false;
  return r.base !== mergeBase && r.oldMode !== file.oldMode;
}

// near: 경로 → 다른 브랜치에서 확인한 기록의 블록 서명이나 blob(branchMatches). 이 브랜치에 기록이 아예 없는 파일에만 쓴다
// unseen: 결과 파일이 그때 본 것과 같은 파일의 처음 보는 줄(sameResultCarry·otherBranchCarry). 블록보다 정확하니 먼저 쓴다
export async function buildReview(snap: Snapshot, state: DeviceState, secret: string,
  others?: ReadonlyMap<string, string[]>, moves?: BaseMoves, near?: ReadonlyMap<string, NearMatch>, unseen?: NewLines): Promise<Review> {
  const items: ReviewItem[] = [];
  for (const file of snap.files) {
    const key = await recordKey(secret, snap.owner, snap.repo, snap.branch, file.path);
    const fp = await fingerprint(file);
    const meta = await metaSig(file);
    const blocks = file.patch !== undefined ? await sigsFor(secret, fp, file.patch) : undefined;
    const record = state[key];
    // 손으로 푼 기록이 남 표시보다 이긴다 — 남의 파일은 잠겨 있어 못 푼다. 내 것으로 보이던 때 푼 것이다
    const names = record?.viewed === false ? undefined : others?.get(file.path);
    const hint = unseen?.get(file.path), newLines = hint?.fp === fp ? hint.lines : undefined;
    let st: FileState;
    let newBlocks: number[] | undefined, carried: ReviewItem['carried'], dropped: number | undefined, elsewhere = false;
    let via = record?.via, seenBlob: string | undefined;
    if (names) st = 'viewed';   // 남의 표시가 기록보다 이긴다
    else if (!record) {
      // 다른 브랜치에서 본 블록과 겹치면 안 맞는 블록만 보인다. 전부 맞아도(newBlocks 빈 배열) 확인함으로 치지 않는다 —
      // 서명에 위치가 없어 같은 변경이 파일의 다른 곳에 있을 수 있다. 그때는 전부 흐리게 보인다
      const seen = near?.get(file.path);
      const miss = seen && 'blocks' in seen && blocks ? unmatchedBlocks(seen.blocks, blocks) : undefined;
      if (newLines) { st = 'changed-since-viewed'; elsewhere = true; }
      else if (seen && 'blob' in seen) { st = 'changed-since-viewed'; seenBlob = seen.blob; elsewhere = true; }
      else if (miss && blocks && miss.length < blocks.length) { st = 'changed-since-viewed'; newBlocks = miss; elsewhere = true; }
      else st = 'unread';
    }
    else if (!record.viewed) st = 'unread';
    // 이어받기로 새 대상에 옮겨 쓴 기록: 이전 대상으로 돌아가면 그때 확인한 그대로다
    else if (record.prev && snap.mergeBase === record.prev.base && record.prev.fp === fp) { st = 'viewed'; via = record.prev.via; }
    // 그 밖의 대상에서는 이 기록의 지문·블록이 근거가 안 된다 — 사람이 본 것이 아니다. 이어받기 단계가 사람이 본 diff 와 다시 맞댄다
    else if (record.via === 'target' && record.base !== snap.mergeBase) st = seenBasis(record) ? 'changed-since-viewed' : 'unread';
    else if (record.fp === fp && !sameDiffHides(file, record, snap.mergeBase)) st = 'viewed';
    // 옛 기록·patch 없는 파일·상태/mode 변경은 블록으로 판정하지 않는다(spec §5)
    else if (!record.blocks || !blocks || record.meta !== meta || unseenMode(file, record, snap.mergeBase)) st = 'changed-since-viewed';
    // base 가 그대로면 지문 변화는 전부 내 변경이다 — 블록으로 거를 소음이 없다(같은 블록을 다른 곳에 옮겨도 숨지 않게)
    // 새 파일도 그렇다 — base 쪽이 늘 빈 파일이라 base 가 움직여도 소음이 없고, diff 전체가 블록 하나라 블록으로 보면 파일 전체가 다시 뜬다
    else if (!record.base || !snap.mergeBase || record.base === snap.mergeBase || file.status === 'added') st = 'changed-since-viewed';
    // base 가 움직였어도 이 파일을 안 건드렸으면 base 쪽 내용이 그대로다 — base 가 그대로일 때와 같다
    else if (untouched(moves, record.base, snap.mergeBase, file)) st = 'changed-since-viewed';
    else {
      const miss = unmatchedBlocks(record.blocks, blocks);
      // 블록은 맞지만 결과 파일 줄 번호로 재 보니 다른 자리다 — 서명에는 자리가 없다
      if (miss.length === 0 && newLines) st = 'changed-since-viewed';
      else if (miss.length === 0) {
        // 지금 블록이 전부 맞으면 사라진 확인 블록 수 = 확인 블록 수 - 지금 블록 수.
        // 결과 파일이 그때와 같으면 잃은 것이 없다 — 내가 본 변경이 파일에 그대로 있고 대상이 가져갔을 뿐이다
        const gone = record.blob === file.blobSha ? 0 : record.blocks.length - blocks.length;
        st = 'viewed'; carried = gone > 0 ? 'shrunk' : 'same'; if (gone > 0) dropped = gone;
      }
      else { st = 'changed-since-viewed'; newBlocks = miss; }
    }
    items.push({ file, key, fp, meta, ...(blocks ? { blocks } : {}), ...(snap.mergeBase ? { base: snap.mergeBase } : {}),
      state: st, record, ...(names ? { others: names } : {}), ...(newBlocks ? { newBlocks } : {}), ...(carried ? { carried } : {}), ...(dropped ? { dropped } : {}),
      ...(elsewhere ? { elsewhere: true as const } : {}), ...(seenBlob ? { seenBlob } : {}), ...(newLines && st === 'changed-since-viewed' ? { newLines } : {}), ...(st === 'viewed' && (names || via) ? { auto: true as const } : {}), ...(st === 'viewed' && !names && via ? { carriedOver: true as const } : {}) });
  }
  const viewedCount = items.filter((i) => i.state === 'viewed').length;
  return { items, viewedCount, autoCount: items.filter((i) => i.auto).length, total: items.length, incomplete: snap.truncated,
    complete: !snap.truncated && items.length > 0 && viewedCount === items.length };
}

// 블록 판정을 탄 파일(새 블록이 있거나 블록이 맞아 확인함)의 옛 merge-base — base 이동이 그 파일을 건드렸는지 잴 대상. 상한이 없다:
// 상한이 있으면 체크를 풀어 순위가 바뀔 때 다른 파일이 저절로 뒤집힌다
export function movedBases(review: Review): string[] {
  const out = new Set<string>();
  for (const i of review.items) if ((i.newBlocks || i.carried) && i.record?.base) out.add(i.record.base);
  return [...out];
}

// lockfile 같은 파일 하나가 서명 수천 개로 기록을 수만 자로 키워 localStorage·gist 를 부풀린다 — 넘으면 서명을 안 남겨 옛 기록처럼 판정한다
const MAX_STORED_BLOCKS = 300;

export function markRecord(item: ReviewItem, headSha: string, viewed: boolean, now = new Date()): ViewRecord {
  // 병합은 나중 시각이 이긴다 — 시계가 뒤로 갔어도 방금 누른 것이 앞선 기록을 이기게
  const last = item.record ? Date.parse(item.record.at) : NaN;
  const at = last >= now.getTime() ? new Date(last + 1) : now;
  return { fp: item.fp, blob: item.file.blobSha, head: headSha, at: at.toISOString(), viewed, meta: item.meta,
    ...(item.file.oldMode ? { oldMode: item.file.oldMode } : {}),
    ...(item.blocks && item.blocks.length <= MAX_STORED_BLOCKS ? { blocks: item.blocks } : {}), ...(item.base ? { base: item.base } : {}),
    ...(viewed && item.carryPrev ? { prev: item.carryPrev } : {}) };
}
