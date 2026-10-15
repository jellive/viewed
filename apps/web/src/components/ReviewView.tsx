import type { DeviceState, Snapshot } from '@viewed/core';
import { useReview } from '../useReview';
import type { SyncStore } from '../syncStore';
import { FileList } from './FileList';
import { DiffView } from './DiffView';
import { SinceViewed } from './SinceViewed';
import { t } from '../i18n';

export function ReviewView(a: { snap: Snapshot; merged: DeviceState; secret: string; store: SyncStore; readBlob: (sha: string) => Promise<string | null> }) {
  const { review, toggle, sync } = useReview(a);
  if (!review) return null;
  return (
    <>
      <p data-testid="sync-status" className="sync" data-sync={sync}>{sync === 'error' ? t.syncFailed : sync === 'pending' ? t.saving : t.saved}</p>
      <FileList review={review} syncOk={sync === 'idle'} onToggle={toggle} renderDiff={(it) => it.file.patch === undefined || it.state !== 'changed-since-viewed'
        ? <DiffView patch={it.file.patch} />
        : <SinceViewed readBlob={a.readBlob} item={it} />} />
    </>
  );
}
