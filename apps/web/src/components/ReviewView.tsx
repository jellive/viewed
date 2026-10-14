import type { DeviceState, Snapshot } from '@viewed/core';
import { useReview } from '../useReview';
import type { SyncStore } from '../syncStore';
import { FileList } from './FileList';
import { DiffView } from './DiffView';

export function ReviewView(a: { snap: Snapshot; merged: DeviceState; secret: string; store: SyncStore }) {
  const { review, toggle, sync } = useReview(a);
  if (!review) return null;
  return (
    <>
      <p data-testid="sync-status">{sync === 'error' ? 'sync failed' : sync === 'pending' ? 'saving…' : 'saved'}</p>
      <FileList review={review} syncOk={sync === 'idle'} onToggle={toggle} renderDiff={(it) => <DiffView patch={it.file.patch} />} />
    </>
  );
}
