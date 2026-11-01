import { useEffect, useState } from 'react';
import { structuredPatch } from 'diff';
import { markedHunks, markedLines, type ReviewItem } from '@viewed/core';
import { DiffView } from './DiffView';
import { BaseDiff, type ReadContext } from './BaseDiff';
import { errorText, t } from '../i18n';
import type { DiffAsk, View } from '../ask';

type S = { kind: 'loading' } | { kind: 'ok'; patch: string } | { kind: 'unavailable' } | { kind: 'same' } | { kind: 'bytes' } | { kind: 'error'; msg: string };

// base 가 그대로면 확인 당시 blob → 지금 blob(줄 단위). 움직였으면(리베이스·머지) blob 비교에 base 변경이 섞이므로
// 지금 patch 에서 확인 안 한 블록이 든 덩어리만 보인다 — blob 을 안 읽는다(spec §6). 같은 덩어리의 확인한 블록 줄은 seen(흐리게)
function blocksView(item: ReviewItem): { patch: string; seen: ReadonlySet<number> } | null {
  // 결과 파일이 그때와 같아 처음 보는 줄을 정확히 안다 — 그 줄이 든 덩어리만, 나머지 변경은 흐리게
  if (item.newLines && item.file.patch !== undefined) {
    const m = markedLines(item.file.patch, item.newLines);
    return { patch: m.patch, seen: new Set(m.seen) };
  }
  const same = !!item.record?.base && !!item.base && item.record.base === item.base;
  if (same || !item.newBlocks || item.file.patch === undefined) return null;
  // 다른 브랜치에서 블록을 전부 봤지만 diff 가 다르다(elsewhere) — 덩어리를 빼지 않고 변경 줄을 전부 흐리게
  if (!item.newBlocks.length) {
    const lines = item.file.patch.split('\n');
    return { patch: item.file.patch, seen: new Set(lines.flatMap((l, i) => (l[0] === '-' || l[0] === '+' || l[0] === '\\' ? [i] : []))) };
  }
  const m = markedHunks(item.file.patch, item.newBlocks);
  return { patch: m.patch, seen: new Set(m.seen) };
}

// ask: 보기마다 좌표 규칙이 다르다(spec §5) — 블록 경로는 전체 diff 좌표('since-blocks'), blob 경로는 삭제 줄에 + 가 없다('since-blob')
export function SinceViewed({ readBlob, item, ask, others, readContext, contextKey }: { readBlob: (sha: string) => Promise<string | null>; item: ReviewItem; ask?: (view: View) => DiffAsk | undefined; others?: ReadonlySet<number>; readContext?: ReadContext; contextKey?: string }) {
  const [tab, setTab] = useState<'since' | 'full'>('since');
  const [s, setS] = useState<S>({ kind: 'loading' });
  const byBlocks = blocksView(item);
  const blocked = byBlocks !== null;
  // 이 브랜치 기록이 없는 새 파일은 다른 브랜치에서 확인한 blob 과 맞댄다
  const oldSha = item.record?.blob ?? item.seenBlob, newSha = item.file.blobSha, path = item.file.path;
  useEffect(() => {
    if (blocked) return;
    let live = true;
    setS({ kind: 'loading' });
    if (!oldSha || !newSha) { setS({ kind: 'unavailable' }); return; }
    if (oldSha === newSha) { setS({ kind: 'same' }); return; }
    Promise.all([readBlob(oldSha), readBlob(newSha)])
      .then(([a, b]) => {
        if (!live) return;
        if (a === null || b === null) return setS({ kind: 'unavailable' });
        const p = structuredPatch(path, path, a, b, 'viewed', 'now');
        // blob 은 다른데 글자가 같다 — UTF-8 이 아닌 바이트가 전부 같은 글자로 뭉개졌다. '그대로'라고 하면 안 된다
        if (p.hunks.length === 0) return setS({ kind: 'bytes' });
        setS({ kind: 'ok', patch: p.hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]).join('\n') });
      })
      .catch((e) => { if (live) setS({ kind: 'error', msg: errorText(e) }); });
    return () => { live = false; };
  }, [readBlob, oldSha, newSha, path, blocked]);

  const shown: S = byBlocks !== null ? { kind: 'ok', patch: byBlocks.patch } : s;
  const full = <BaseDiff file={item.file} ask={ask?.('full')} others={others} readContext={readContext} contextKey={contextKey} />;
  if (shown.kind === 'unavailable')
    return <div><p data-testid="since-unavailable" className="note">{t.sinceUnavailable}</p>{full}</div>;
  if (shown.kind === 'same')
    return <div><p data-testid="since-same-content" className="note">{t.sinceSame}</p>{full}</div>;
  if (shown.kind === 'bytes')
    return <div><p data-testid="since-bytes" role="alert" className="flash warn">{t.sinceBytes}</p>{full}</div>;
  if (shown.kind === 'error') return <div><p data-testid="since-error" role="alert" className="flash err">{shown.msg}</p>{full}</div>;
  return (
    <div>
      {byBlocks !== null && tab === 'since' && <p data-testid="since-blocks" className="note">{item.newLines ? (item.elsewhere ? t.sinceNewLinesElsewhere : t.sinceNewLines) : item.elsewhere ? (item.newBlocks?.length ? t.sinceElsewhere : t.sinceElsewhereAll) : t.sinceBlocks}</p>}
      {item.seenBlob && tab === 'since' && <p data-testid="since-elsewhere-lines" className="note">{t.sinceElsewhereLines}</p>}
      <div className="tabs">
        <button data-testid="since-tab" aria-pressed={tab === 'since'} onClick={() => setTab('since')}>{t.sinceTab}</button>
        <button data-testid="full-tab" aria-pressed={tab === 'full'} onClick={() => setTab('full')}>{t.fullTab}</button>
      </div>
      {tab === 'full' ? full
        : shown.kind === 'loading' ? <p className="note">{t.loading}</p>
        : <div data-testid="since-diff"><DiffView patch={shown.patch} seen={byBlocks?.seen} ask={ask?.(blocked ? 'since-blocks' : 'since-blob')} others={others} /></div>}
    </div>
  );
}
