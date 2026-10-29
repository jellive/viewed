import { fingerprint } from './fingerprint';
import { recordKey } from './keys';
import { blockSigs, metaSig, unmatchedBlocks } from './blocks';
import type { BaseMoves, ChangedFile, DeviceState, FileState, Review, ReviewItem, Snapshot, ViewRecord } from './types';

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

// base 가 from → to 로 움직이며 이 파일(이전 경로 포함)을 안 건드렸는지. 못 쟀거나 다른 to 를 두고 잰 근거면 false
function untouched(moves: BaseMoves | undefined, from: string, to: string, file: ChangedFile): boolean {
  const s = moves?.to === to ? moves.from.get(from) : undefined;
  return !!s && !s.has(file.path) && !(file.previousPath !== undefined && s.has(file.previousPath));
}

export async function buildReview(snap: Snapshot, state: DeviceState, secret: string,
  others?: ReadonlyMap<string, string[]>, moves?: BaseMoves): Promise<Review> {
  const items: ReviewItem[] = [];
  for (const file of snap.files) {
    const key = await recordKey(secret, snap.owner, snap.repo, snap.branch, file.path);
    const fp = await fingerprint(file);
    const meta = await metaSig(file);
    const blocks = file.patch !== undefined ? await sigsFor(secret, fp, file.patch) : undefined;
    const record = state[key];
    const names = others?.get(file.path);
    let st: FileState;
    let newBlocks: number[] | undefined, carried: ReviewItem['carried'], dropped: number | undefined;
    if (names) st = 'viewed';   // 남의 표시가 기록보다 이긴다
    else if (!record || !record.viewed) st = 'unread';
    else if (record.fp === fp) st = 'viewed';
    // 이어받기(b)로 새 대상에 옮겨 쓴 기록: 이전 대상으로 돌아가면 그때 확인한 그대로다
    else if (record.prev && snap.mergeBase === record.prev.base && record.prev.fp === fp) st = 'viewed';
    // 옛 기록·patch 없는 파일·상태/mode 변경은 블록으로 판정하지 않는다(spec §5)
    else if (!record.blocks || !blocks || record.meta !== meta) st = 'changed-since-viewed';
    // base 가 그대로면 지문 변화는 전부 내 변경이다 — 블록으로 거를 소음이 없다(같은 블록을 다른 곳에 옮겨도 숨지 않게)
    // 새 파일도 그렇다 — base 쪽이 늘 빈 파일이라 base 가 움직여도 소음이 없고, diff 전체가 블록 하나라 블록으로 보면 파일 전체가 다시 뜬다
    else if (!record.base || !snap.mergeBase || record.base === snap.mergeBase || file.status === 'added') st = 'changed-since-viewed';
    // base 가 움직였어도 이 파일을 안 건드렸으면 base 쪽 내용이 그대로다 — base 가 그대로일 때와 같다
    else if (untouched(moves, record.base, snap.mergeBase, file)) st = 'changed-since-viewed';
    else {
      const miss = unmatchedBlocks(record.blocks, blocks);
      if (miss.length === 0) {
        // 지금 블록이 전부 맞으면 사라진 확인 블록 수 = 확인 블록 수 - 지금 블록 수
        const gone = record.blocks.length - blocks.length;
        st = 'viewed'; carried = gone > 0 ? 'shrunk' : 'same'; if (gone > 0) dropped = gone;
      }
      else { st = 'changed-since-viewed'; newBlocks = miss; }
    }
    items.push({ file, key, fp, meta, ...(blocks ? { blocks } : {}), ...(snap.mergeBase ? { base: snap.mergeBase } : {}),
      state: st, record, ...(names ? { others: names } : {}), ...(newBlocks ? { newBlocks } : {}), ...(carried ? { carried } : {}), ...(dropped ? { dropped } : {}) });
  }
  const viewedCount = items.filter((i) => i.state === 'viewed').length;
  return { items, viewedCount, total: items.length, incomplete: snap.truncated,
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
  return { fp: item.fp, blob: item.file.blobSha, head: headSha, at: now.toISOString(), viewed, meta: item.meta,
    ...(item.blocks && item.blocks.length <= MAX_STORED_BLOCKS ? { blocks: item.blocks } : {}), ...(item.base ? { base: item.base } : {}),
    ...(viewed && item.carryPrev ? { prev: item.carryPrev } : {}) };
}
