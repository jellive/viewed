import type { DeviceState, Snapshot } from '@viewed/core';
import { useReview } from '../useReview';
import type { SyncStore } from '../syncStore';
import { FileList } from './FileList';
import { DiffView } from './DiffView';
import { SinceViewed } from './SinceViewed';
import { t } from '../i18n';

export function ReviewView(a: { snap: Snapshot; merged: DeviceState; secret: string; store: SyncStore; readBlob: (sha: string) => Promise<string | null>; onRefresh: () => void; live: boolean }) {
  const { review, toggle, sync } = useReview(a);
  if (!review) return null;
  return (
    <>
      <div className="review-bar">
        <button type="button" data-testid="refresh-btn" className="refresh" onClick={a.onRefresh} title={a.live ? t.liveHint : undefined}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
          {t.refresh}
        </button>
        {a.live && <span className="live">{t.live}</span>}
        <p data-testid="sync-status" className="sync" data-sync={sync}>{sync === 'error' ? t.syncFailed : sync === 'pending' ? t.saving : t.saved}</p>
      </div>
      <FileList review={review} syncOk={sync === 'idle'} onToggle={toggle} renderDiff={(it) => it.file.patch === undefined || it.state !== 'changed-since-viewed'
        ? <DiffView patch={it.file.patch} />
        : <SinceViewed readBlob={a.readBlob} item={it} />} />
    </>
  );
}
