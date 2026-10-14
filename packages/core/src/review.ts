import { fingerprint } from './fingerprint';
import { recordKey } from './keys';
import type { DeviceState, Review, ReviewItem, Snapshot, ViewRecord } from './types';

export async function buildReview(snap: Snapshot, state: DeviceState, secret: string): Promise<Review> {
  const items: ReviewItem[] = [];
  for (const file of snap.files) {
    const key = await recordKey(secret, snap.owner, snap.repo, snap.branch, file.path);
    const fp = await fingerprint(file);
    const record = state[key];
    const state_ = !record || !record.viewed ? 'unread' : record.fp === fp ? 'viewed' : 'changed-since-viewed';
    items.push({ file, key, fp, state: state_, record });
  }
  const viewedCount = items.filter((i) => i.state === 'viewed').length;
  return { items, viewedCount, total: items.length, incomplete: snap.truncated,
    complete: !snap.truncated && items.length > 0 && viewedCount === items.length };
}

export function markRecord(item: ReviewItem, headSha: string, viewed: boolean, now = new Date()): ViewRecord {
  return { fp: item.fp, blob: item.file.blobSha, head: headSha, at: now.toISOString(), viewed };
}
