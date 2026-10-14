import type { ReactNode } from 'react';
import type { Review, ReviewItem } from '@viewed/core';

const MARK = { viewed: '✓', unread: '•', 'changed-since-viewed': 'changed' } as const;

// 완료는 목록이 온전하고(review.complete) 기록이 gist 에 저장됐을 때만(syncOk) — spec §8
export function FileList({ review, syncOk, onToggle, renderDiff }: { review: Review; syncOk: boolean; onToggle: (i: ReviewItem, v: boolean) => void; renderDiff: (i: ReviewItem) => ReactNode }) {
  return (
    <section>
      <p data-testid="progress">{review.viewedCount} / {review.total}</p>
      {review.incomplete && <p data-testid="banner-incomplete" role="alert">GitHub returned 300 files — the list may be cut off. This branch can't be marked complete here.</p>}
      {review.complete && syncOk && <p data-testid="complete">All files viewed.</p>}
      <ul>
        {review.items.map((it) => (
          <li key={it.key} data-testid="file-row" data-state={it.state}>
            <label>
              <input type="checkbox" data-testid="file-check" checked={it.state === 'viewed'} onChange={(e) => onToggle(it, e.target.checked)} />
              <span data-testid="file-state">{MARK[it.state]}</span> {it.file.path}
            </label>
            {it.state !== 'viewed' && renderDiff(it)}
          </li>
        ))}
      </ul>
    </section>
  );
}
