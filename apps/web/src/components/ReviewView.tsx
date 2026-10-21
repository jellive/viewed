import type { Author, DeviceState, Snapshot } from '@viewed/core';
import { useReview } from '../useReview';
import type { SyncStore } from '../syncStore';
import { FileList } from './FileList';
import { DiffView } from './DiffView';
import { SinceViewed } from './SinceViewed';
import { t } from '../i18n';
import { useThreads } from '../ask';

export function ReviewView(a: { snap: Snapshot; merged: DeviceState; secret: string; store: SyncStore; readBlob: (sha: string) => Promise<string | null>; onRefresh: () => void; live: boolean; askRepo?: string; others?: ReadonlyMap<string, string[]>; isMe?: (a: Author) => boolean }) {
  const { review, toggle, sync } = useReview(a);
  // 스레드는 여기(FileList 위)에 둔다 — 접기·필터로 diff 가 사라져도 남게. 로컬로 연 리뷰(askRepo)에만 + 가 붙는다
  const { forFile } = useThreads({ repo: a.askRepo, snap: a.snap, bridge: window.viewedDesktop?.ask });
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
        ? <DiffView patch={it.file.patch} ask={forFile(it, 'full')} />
        : <SinceViewed readBlob={a.readBlob} item={it} ask={(v) => forFile(it, v)} />} />
    </>
  );
}
