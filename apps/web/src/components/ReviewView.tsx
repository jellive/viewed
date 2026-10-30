import { useMemo } from 'react';
import { makeCarry } from '../targetCarry';
import { makeMoves } from '../baseMoves';
import type { Author, DeviceState, Snapshot } from '@viewed/core';
import { useReview } from '../useReview';
import type { SyncStore } from '../syncStore';
import { FileList } from './FileList';
import { DiffView } from './DiffView';
import { SinceViewed } from './SinceViewed';
import { t } from '../i18n';
import { useThreads } from '../ask';
import { useOtherLines, type BlameSrc } from '../lineAuthors';
import type { DiffAsk, View } from '../ask';
import type { ReviewItem } from '@viewed/core';

// branches: 로컬 모드에서 같은 레포의 다른 브랜치 이름 — 브랜치를 옮겨 와도 거기서 확인한 것을 찾는다
export function ReviewView(a: { snap: Snapshot; merged: DeviceState; secret: string; store: SyncStore; readBlob: (sha: string) => Promise<string | null>; onRefresh: () => void; live: boolean; askRepo?: string; others?: ReadonlyMap<string, string[]>; isMe?: (a: Author) => boolean; branches?: readonly string[] }) {
  const carry = useMemo(() => (a.askRepo ? makeCarry(a.askRepo) : undefined), [a.askRepo]);
  const moves = useMemo(() => (a.askRepo ? makeMoves(a.askRepo) : undefined), [a.askRepo]);
  const { review, shownSnap, toggle, sync } = useReview({ ...a, carry, moves });
  // 스레드는 여기(FileList 위)에 둔다 — 접기·필터로 diff 가 사라져도 남게. 로컬로 연 리뷰(askRepo)에만 + 가 붙는다
  const { forFile } = useThreads({ repo: a.askRepo, snap: a.snap, bridge: window.viewedDesktop?.ask });
  if (!review) return <p data-testid="review-loading" className="hint">{t.loading}</p>;
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
      <FileList review={review} syncOk={sync === 'idle'} onToggle={toggle} renderDiff={(it) => (
        <FileDiff item={it} readBlob={a.readBlob} forFile={forFile} src={a.askRepo && a.isMe && shownSnap?.mergeBase ? { repo: a.askRepo, head: shownSnap.headSha, mergeBase: shownSnap.mergeBase, isMe: a.isMe } : undefined} />
      )} />
    </>
  );
}

// 펼쳐진 파일 하나 — 렌더될 때만 blame 을 부른다(접힌 파일은 이 컴포넌트가 없다). 지울 파일·patch 없는 파일은 blame 할 줄이 없다
function FileDiff({ item: it, readBlob, forFile, src }: { item: ReviewItem; readBlob: (sha: string) => Promise<string | null>; forFile: (it: ReviewItem, v: View) => DiffAsk | undefined; src?: BlameSrc }) {
  const has = it.file.patch !== undefined && it.file.status !== 'removed';
  const others = useOtherLines(has ? src : undefined, it.file.path);
  return it.file.patch === undefined || it.state !== 'changed-since-viewed'
    ? <DiffView patch={it.file.patch} ask={forFile(it, 'full')} others={others} />
    : <SinceViewed readBlob={readBlob} item={it} ask={(v) => forFile(it, v)} others={others} />;
}
