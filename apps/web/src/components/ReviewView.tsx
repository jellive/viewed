import type { GitHub, DeviceState, Snapshot } from '@viewed/core';
import { useReview } from '../useReview';
import { FileList } from './FileList';
import { DiffView } from './DiffView';

export function ReviewView(a: { snap: Snapshot; merged: DeviceState; own: DeviceState; secret: string; gh: GitHub; gistId: string; deviceId: string }) {
  const { review, toggle, sync } = useReview(a);
  if (!review) return null;
  return (
    <>
      <p data-testid="sync-status">{sync === 'error' ? 'sync failed' : sync === 'pending' ? 'saving…' : 'saved'}</p>
      <FileList review={review} syncOk={sync === 'idle'} onToggle={toggle} renderDiff={(it) => <DiffView patch={it.file.patch} />} />
    </>
  );
}
