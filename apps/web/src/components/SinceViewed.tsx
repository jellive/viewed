import { useEffect, useState } from 'react';
import { structuredPatch } from 'diff';
import type { GitHub, ReviewItem } from '@viewed/core';
import { DiffView } from './DiffView';

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
      .catch((e) => { if (live) setS({ kind: 'error', msg: String(e) }); });
    return () => { live = false; };
  }, [gh, owner, repo, oldSha, newSha, path]);

  if (s.kind === 'unavailable')
    return <div><p data-testid="since-unavailable">The version you viewed is no longer on GitHub (force-push?). Showing the full diff.</p><DiffView patch={item.file.patch} /></div>;
  if (s.kind === 'same')
    return <div><p data-testid="since-same-content">File content is unchanged since you viewed it; the diff against the base changed.</p><DiffView patch={item.file.patch} /></div>;
  if (s.kind === 'error') return <div><p data-testid="since-error" role="alert">{s.msg}</p><DiffView patch={item.file.patch} /></div>;
  return (
    <div>
      <button data-testid="since-tab" onClick={() => setTab('since')}>since viewed</button>
      <button data-testid="full-tab" onClick={() => setTab('full')}>full diff</button>
      {tab === 'full' ? <DiffView patch={item.file.patch} />
        : s.kind === 'loading' ? <p>loading…</p>
        : <div data-testid="since-diff"><DiffView patch={s.patch} /></div>}
    </div>
  );
}
