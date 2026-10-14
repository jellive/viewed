import type { DeviceState, GitHub, Snapshot } from '@viewed/core';
import { useReview } from '../useReview';
import type { SyncStore } from '../syncStore';
import { FileList } from './FileList';
import { DiffView } from './DiffView';
import { SinceViewed } from './SinceViewed';

export function ReviewView(a: { snap: Snapshot; merged: DeviceState; secret: string; store: SyncStore; gh: GitHub }) {
  const { review, toggle, sync } = useReview(a);
  if (!review) return null;
  return (
    <>
      <p data-testid="sync-status">{sync === 'error' ? 'sync failed' : sync === 'pending' ? 'saving…' : 'saved'}</p>
      <FileList review={review} syncOk={sync === 'idle'} onToggle={toggle} renderDiff={(it) => it.file.patch === undefined || it.state !== 'changed-since-viewed'
        ? <DiffView patch={it.file.patch} />
        : <SinceViewed gh={a.gh} owner={a.snap.owner} repo={a.snap.repo} item={it} />} />
    </>
  );
}
