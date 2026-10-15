import { useState, type ReactNode } from 'react';
import type { Review, ReviewItem } from '@viewed/core';
import { t } from '../i18n';

const MARK = { viewed: '', unread: '', 'changed-since-viewed': t.changedSinceViewed } as const;

// 완료는 목록이 온전하고(review.complete) 기록이 gist 에 저장됐을 때만(syncOk) — spec §8
export function FileList({ review, syncOk, onToggle, renderDiff }: { review: Review; syncOk: boolean; onToggle: (i: ReviewItem, v: boolean) => void; renderDiff: (i: ReviewItem) => ReactNode }) {
  const pct = review.total ? (review.viewedCount / review.total) * 100 : 0;
  const [onlyUnviewed, setOnlyUnviewed] = useState(false);
  const shown = onlyUnviewed ? review.items.filter((it) => it.state !== 'viewed') : review.items;
  return (
    <section className="review">
      <div className="progress">
        <span><b data-testid="progress">{review.viewedCount} / {review.total}</b> {t.filesViewed}</span>
        <span className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
        <label className="filter"><input type="checkbox" data-testid="filter-unviewed" checked={onlyUnviewed} onChange={(e) => setOnlyUnviewed(e.target.checked)} /> {t.onlyUnviewed}</label>
      </div>
      {review.incomplete && <p data-testid="banner-incomplete" role="alert" className="flash warn">{t.incomplete}</p>}
      {review.complete && syncOk && <p data-testid="complete" className="flash ok">{t.allViewed}</p>}
      <ul className="files">
        {shown.map((it) => (
          <li key={it.key} data-testid="file-row" data-state={it.state} className="file">
            <div className="file-head">
              <span className="path">{it.file.path}</span>
              <span data-testid="file-state" className="badge">{MARK[it.state]}</span>
              <label className="viewed-toggle">
                <input type="checkbox" data-testid="file-check" aria-label={t.viewedFile(it.file.path)} checked={it.state === 'viewed'} onChange={(e) => onToggle(it, e.target.checked)} />
                {t.viewed}
              </label>
            </div>
            {it.state !== 'viewed' && <div className="file-body">{renderDiff(it)}</div>}
          </li>
        ))}
      </ul>
      {onlyUnviewed && shown.length === 0 && review.total > 0 && <p data-testid="filter-empty" className="note">{t.nothingLeft}</p>}
    </section>
  );
}
