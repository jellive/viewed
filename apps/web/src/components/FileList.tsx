import { useState, type ReactNode } from 'react';
import type { Review, ReviewItem } from '@viewed/core';
import { t } from '../i18n';

const MARK = { viewed: '', unread: '', 'changed-since-viewed': t.changedSinceViewed } as const;

// 완료는 목록이 온전하고(review.complete) 기록이 gist 에 저장됐을 때만(syncOk) — spec §8
export function FileList({ review, syncOk, onToggle, renderDiff }: { review: Review; syncOk: boolean; onToggle: (i: ReviewItem, v: boolean) => void; renderDiff: (i: ReviewItem) => ReactNode }) {
  const pct = review.total ? (review.viewedCount / review.total) * 100 : 0;
  const [onlyUnviewed, setOnlyUnviewed] = useState(false);
  const [query, setQuery] = useState('');
  // 머리를 눌러 펼치고 접은 것. 그때의 지문이 지금과 같을 때만 따른다 — 새 커밋이 바꾼 파일은 기본값(펼침)으로 돌아가 바뀐 줄이 숨지 않는다
  const [picked, setPicked] = useState<Record<string, { open: boolean; fp: string }>>({});
  const isOpen = (it: ReviewItem) => (picked[it.key]?.fp === it.fp ? picked[it.key].open : it.state !== 'viewed');
  // 확인한 블록이 빠진 파일(shrunk)은 확인함이지만 경고가 붙은 것 — 숨기면 그 경고를 볼 곳이 없다
  const byState = onlyUnviewed ? review.items.filter((it) => it.state !== 'viewed' || it.carried === 'shrunk') : review.items;
  // 검색은 보이는 목록만 좁힌다 — 진행률·완료는 review 전체 기준 그대로. 경로에 글자가 그대로 들어간 것만(퍼지 아님), 대소문자·앞뒤 공백 무시
  const needle = query.trim().toLowerCase();
  const shown = needle ? byState.filter((it) => it.file.path.toLowerCase().includes(needle)) : byState;
  return (
    <section className="review">
      <div className="progress">
        <span><b data-testid="progress">{review.viewedCount} / {review.total}</b> {t.filesViewed}</span>
        <span className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
        <input type="search" className="search" data-testid="file-search" aria-label={t.aria.searchFiles} placeholder={t.searchFiles} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="filter"><input type="checkbox" data-testid="filter-unviewed" checked={onlyUnviewed} onChange={(e) => setOnlyUnviewed(e.target.checked)} /> {t.onlyUnviewed}</label>
      </div>
      {review.incomplete && <p data-testid="banner-incomplete" role="alert" className="flash warn">{t.incomplete}</p>}
      {review.complete && syncOk && <p data-testid="complete" className="flash ok">{t.allViewed}</p>}
      <ul className="files">
        {shown.map((it) => {
          const open = isOpen(it);
          const flip = () => setPicked((p) => ({ ...p, [it.key]: { open: !open, fp: it.fp } }));
          return (
            <li key={it.key} data-testid="file-row" data-state={it.state} className="file" {...(it.others ? { 'data-others': '1' } : {})}>
              {/* 머리 빈 곳을 눌러도 꺾쇠처럼 펼친다. 체크 라벨·버튼·링크는 각자 일하고(겹치면 두 번 바뀐다), 경로 글자는 고르는 데만 쓴다
                  (더블클릭으로 파일 이름을 복사하면 첫 클릭에 펼침이 바뀐다). 머리 어디서든 드래그로 고르는 중이면 그대로.
                  키보드는 꺾쇠 버튼이 맡는다 — 머리에 role·tabindex 를 달면 탭 정지가 겹친다 */}
              <div className="file-head" onClick={(e) => {
                if ((e.target as Element).closest('label, input, button, a, .path')) return;
                if (window.getSelection()?.toString()) return;
                flip();
              }}>
                {/* 경로는 버튼 밖에 둬 드래그로 복사할 수 있게 */}
                <button type="button" data-testid="file-expand" className="expand" aria-expanded={open} aria-label={t.toggleDiffOf(it.file.path)} title={t.toggleDiff}
                  onClick={flip}>
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
                </button>
                <span className="path">{it.file.path}</span>
                {/* carried: 리베이스·머지로 diff 는 바뀌었지만 지금 블록은 전부 본 것. 'same' 은 중립 배지,
                    'shrunk' 는 확인한 블록이 일부 빠진 것이라(base 흡수인지 유실인지 서명으로는 못 가름) 경고색 */}
                <span data-testid="file-state" className={it.carried === 'same' ? 'badge muted' : 'badge'}>
                  {it.carried === 'same' ? t.carried : it.carried === 'shrunk' ? t.carriedDropped(it.dropped ?? 0) : MARK[it.state]}
                </span>
                {it.others && <span data-testid="file-others" className="badge others" title={it.others.join(', ')}>{t.othersBadge(it.others)}</span>}
                <label className="viewed-toggle" title={it.others ? t.othersAuto : undefined}>
                  {/* 체크하면 접고 풀면 펼친다 — 머리로 고른 것은 덮는다. 판정이 비동기라 목표 상태를 바로 넣어야 옛 state 로 한 번 그려질 때 깜빡이지 않는다 */}
                  <input type="checkbox" data-testid="file-check" aria-label={t.viewedFile(it.file.path)} checked={it.state === 'viewed'} disabled={!!it.others} onChange={(e) => {
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
      {needle && shown.length === 0 && <p data-testid="search-empty" className="note">{t.noMatch}</p>}
      {!needle && onlyUnviewed && shown.length === 0 && review.total > 0 && <p data-testid="filter-empty" className="note">{t.nothingLeft}</p>}
    </section>
  );
}
