import { fingerprint } from './fingerprint';
import { recordKey } from './keys';
import { blockSigs, metaSig, unmatchedBlocks } from './blocks';
import type { DeviceState, FileState, Review, ReviewItem, Snapshot, ViewRecord } from './types';

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

export async function buildReview(snap: Snapshot, state: DeviceState, secret: string): Promise<Review> {
  const items: ReviewItem[] = [];
  for (const file of snap.files) {
    const key = await recordKey(secret, snap.owner, snap.repo, snap.branch, file.path);
    const fp = await fingerprint(file);
    const meta = await metaSig(file);
    const blocks = file.patch !== undefined ? await sigsFor(secret, fp, file.patch) : undefined;
    const record = state[key];
    let st: FileState;
    let newBlocks: number[] | undefined, carried = false;
    if (!record || !record.viewed) st = 'unread';
    else if (record.fp === fp) st = 'viewed';
    // 옛 기록·patch 없는 파일·상태/mode 변경은 블록으로 판정하지 않는다(spec §5)
    else if (!record.blocks || !blocks || record.meta !== meta) st = 'changed-since-viewed';
    else {
      const miss = unmatchedBlocks(record.blocks, blocks);
      if (miss.length === 0) { st = 'viewed'; carried = true; }
      else { st = 'changed-since-viewed'; newBlocks = miss; }
    }
    items.push({ file, key, fp, meta, ...(blocks ? { blocks } : {}), ...(snap.mergeBase ? { base: snap.mergeBase } : {}),
      state: st, record, ...(newBlocks ? { newBlocks } : {}), ...(carried ? { carried } : {}) });
  }
  const viewedCount = items.filter((i) => i.state === 'viewed').length;
  return { items, viewedCount, total: items.length, incomplete: snap.truncated,
    complete: !snap.truncated && items.length > 0 && viewedCount === items.length };
}

export function markRecord(item: ReviewItem, headSha: string, viewed: boolean, now = new Date()): ViewRecord {
  return { fp: item.fp, blob: item.file.blobSha, head: headSha, at: now.toISOString(), viewed, meta: item.meta,
    ...(item.blocks ? { blocks: item.blocks } : {}), ...(item.base ? { base: item.base } : {}) };
}
