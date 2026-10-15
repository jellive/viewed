import { useEffect, useState } from 'react';
import { structuredPatch } from 'diff';
import type { GitHub, ReviewItem } from '@viewed/core';
import { DiffView } from './DiffView';
import { errorText, t } from '../i18n';

type S = { kind: 'loading' } | { kind: 'ok'; patch: string } | { kind: 'unavailable' } | { kind: 'same' } | { kind: 'error'; msg: string };

export function SinceViewed({ gh, owner, repo, item }: { gh: GitHub; owner: string; repo: string; item: ReviewItem }) {
  const [tab, setTab] = useState<'since' | 'full'>('since');
  const [s, setS] = useState<S>({ kind: 'loading' });
  const oldSha = item.record?.blob, newSha = item.file.blobSha, path = item.file.path;
  useEffect(() => {
    let live = true;
    setS({ kind: 'loading' });
    if (!oldSha || !newSha) { setS({ kind: 'unavailable' }); return; }
    if (oldSha === newSha) { setS({ kind: 'same' }); return; }
    Promise.all([gh.blobText(owner, repo, oldSha), gh.blobText(owner, repo, newSha)])
      .then(([a, b]) => {
        if (!live) return;
        if (a === null || b === null) return setS({ kind: 'unavailable' });
        const p = structuredPatch(path, path, a, b, 'viewed', 'now');
        if (p.hunks.length === 0) return setS({ kind: 'same' });
        setS({ kind: 'ok', patch: p.hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]).join('\n') });
      })
      .catch((e) => { if (live) setS({ kind: 'error', msg: errorText(e) }); });
    return () => { live = false; };
  }, [gh, owner, repo, oldSha, newSha, path]);

  if (s.kind === 'unavailable')
    return <div><p data-testid="since-unavailable" className="note">{t.sinceUnavailable}</p><DiffView patch={item.file.patch} /></div>;
  if (s.kind === 'same')
    return <div><p data-testid="since-same-content" className="note">{t.sinceSame}</p><DiffView patch={item.file.patch} /></div>;
  if (s.kind === 'error') return <div><p data-testid="since-error" role="alert" className="flash err">{s.msg}</p><DiffView patch={item.file.patch} /></div>;
  return (
    <div>
      <div className="tabs">
        <button data-testid="since-tab" aria-pressed={tab === 'since'} onClick={() => setTab('since')}>{t.sinceTab}</button>
        <button data-testid="full-tab" aria-pressed={tab === 'full'} onClick={() => setTab('full')}>{t.fullTab}</button>
      </div>
      {tab === 'full' ? <DiffView patch={item.file.patch} />
        : s.kind === 'loading' ? <p className="note">{t.loading}</p>
        : <div data-testid="since-diff"><DiffView patch={s.patch} /></div>}
    </div>
  );
}
