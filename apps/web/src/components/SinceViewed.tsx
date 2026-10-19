import { useEffect, useState } from 'react';
import { structuredPatch } from 'diff';
import { hunksWithBlocks, type ReviewItem } from '@viewed/core';
import { DiffView } from './DiffView';
import { errorText, t } from '../i18n';

type S = { kind: 'loading' } | { kind: 'ok'; patch: string } | { kind: 'unavailable' } | { kind: 'same' } | { kind: 'error'; msg: string };

// base 가 그대로면 확인 당시 blob → 지금 blob(줄 단위). 움직였으면(리베이스·머지) blob 비교에 base 변경이 섞이므로
// 지금 patch 에서 확인 안 한 블록이 든 덩어리만 보인다 — blob 을 안 읽는다(spec §6)
function blocksView(item: ReviewItem): string | null {
  const same = !!item.record?.base && !!item.base && item.record.base === item.base;
  return !same && item.newBlocks && item.file.patch !== undefined ? hunksWithBlocks(item.file.patch, item.newBlocks) : null;
}

export function SinceViewed({ readBlob, item }: { readBlob: (sha: string) => Promise<string | null>; item: ReviewItem }) {
  const [tab, setTab] = useState<'since' | 'full'>('since');
  const [s, setS] = useState<S>({ kind: 'loading' });
  const byBlocks = blocksView(item);
  const oldSha = item.record?.blob, newSha = item.file.blobSha, path = item.file.path;
  useEffect(() => {
    if (byBlocks !== null) return;
    let live = true;
    setS({ kind: 'loading' });
    if (!oldSha || !newSha) { setS({ kind: 'unavailable' }); return; }
    if (oldSha === newSha) { setS({ kind: 'same' }); return; }
    Promise.all([readBlob(oldSha), readBlob(newSha)])
      .then(([a, b]) => {
        if (!live) return;
        if (a === null || b === null) return setS({ kind: 'unavailable' });
        const p = structuredPatch(path, path, a, b, 'viewed', 'now');
        if (p.hunks.length === 0) return setS({ kind: 'same' });
        setS({ kind: 'ok', patch: p.hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]).join('\n') });
      })
      .catch((e) => { if (live) setS({ kind: 'error', msg: errorText(e) }); });
    return () => { live = false; };
  }, [readBlob, oldSha, newSha, path, byBlocks]);

  const shown: S = byBlocks !== null ? { kind: 'ok', patch: byBlocks } : s;
  if (shown.kind === 'unavailable')
    return <div><p data-testid="since-unavailable" className="note">{t.sinceUnavailable}</p><DiffView patch={item.file.patch} /></div>;
  if (shown.kind === 'same')
    return <div><p data-testid="since-same-content" className="note">{t.sinceSame}</p><DiffView patch={item.file.patch} /></div>;
  if (shown.kind === 'error') return <div><p data-testid="since-error" role="alert" className="flash err">{shown.msg}</p><DiffView patch={item.file.patch} /></div>;
  return (
    <div>
      {byBlocks !== null && <p data-testid="since-blocks" className="note">{t.sinceBlocks}</p>}
      <div className="tabs">
        <button data-testid="since-tab" aria-pressed={tab === 'since'} onClick={() => setTab('since')}>{t.sinceTab}</button>
        <button data-testid="full-tab" aria-pressed={tab === 'full'} onClick={() => setTab('full')}>{t.fullTab}</button>
      </div>
      {tab === 'full' ? <DiffView patch={item.file.patch} />
        : shown.kind === 'loading' ? <p className="note">{t.loading}</p>
        : <div data-testid="since-diff"><DiffView patch={shown.patch} /></div>}
    </div>
  );
}
