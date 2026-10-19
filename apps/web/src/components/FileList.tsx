import { useState, type ReactNode } from 'react';
import type { Review, ReviewItem } from '@viewed/core';
import { t } from '../i18n';

const MARK = { viewed: '', unread: '', 'changed-since-viewed': t.changedSinceViewed } as const;

// 완료는 목록이 온전하고(review.complete) 기록이 gist 에 저장됐을 때만(syncOk) — spec §8
export function FileList({ review, syncOk, onToggle, renderDiff }: { review: Review; syncOk: boolean; onToggle: (i: ReviewItem, v: boolean) => void; renderDiff: (i: ReviewItem) => ReactNode }) {
  const pct = review.total ? (review.viewedCount / review.total) * 100 : 0;
  const [onlyUnviewed, setOnlyUnviewed] = useState(false);
  // 머리를 눌러 펼치고 접은 것. 그때의 지문이 지금과 같을 때만 따른다 — 새 커밋이 바꾼 파일은 기본값(펼침)으로 돌아가 바뀐 줄이 숨지 않는다
  const [picked, setPicked] = useState<Record<string, { open: boolean; fp: string }>>({});
  const isOpen = (it: ReviewItem) => (picked[it.key]?.fp === it.fp ? picked[it.key].open : it.state !== 'viewed');
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
        {shown.map((it) => {
          const open = isOpen(it);
          return (
            <li key={it.key} data-testid="file-row" data-state={it.state} className="file">
              <div className="file-head">
                {/* 경로는 버튼 밖에 둬 드래그로 복사할 수 있게 — 펼침은 앞의 작은 버튼만 */}
                <button type="button" data-testid="file-expand" className="expand" aria-expanded={open} aria-label={t.toggleDiff} title={t.toggleDiff}
                  onClick={() => setPicked((p) => ({ ...p, [it.key]: { open: !open, fp: it.fp } }))}>
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
                </button>
                <span className="path">{it.file.path}</span>
                {/* carried: 리베이스·머지로 diff 는 바뀌었지만 내 변경 블록은 전부 본 것 — 경고색이 아닌 중립 배지 */}
                <span data-testid="file-state" className={it.carried ? 'badge muted' : 'badge'}>{it.carried ? t.carried : MARK[it.state]}</span>
                <label className="viewed-toggle">
                  {/* 체크하면 접고 풀면 펼친다 — 머리로 고른 것은 덮는다. 판정이 비동기라 목표 상태를 바로 넣어야 옛 state 로 한 번 그려질 때 깜빡이지 않는다 */}
                  <input type="checkbox" data-testid="file-check" aria-label={t.viewedFile(it.file.path)} checked={it.state === 'viewed'} onChange={(e) => {
                    const v = e.target.checked;
                    setPicked((p) => ({ ...p, [it.key]: { open: !v, fp: it.fp } }));
                    onToggle(it, v);
                  }} />
                  {t.viewed}
                </label>
              </div>
              {open && <div className="file-body">{renderDiff(it)}</div>}
            </li>
          );
        })}
      </ul>
      {onlyUnviewed && shown.length === 0 && review.total > 0 && <p data-testid="filter-empty" className="note">{t.nothingLeft}</p>}
    </section>
  );
}
