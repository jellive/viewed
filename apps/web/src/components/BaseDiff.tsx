import { useEffect, useState } from 'react';
import type { ChangedFile } from '@viewed/core';
import { DiffView } from './DiffView';
import { t } from '../i18n';
import type { DiffAsk } from '../ask';

// 이보다 긴 파일은 줄마다 DOM 을 만들면 창이 멎는다 — 변경만 보여 준다
const MAX_LINES = 20_000;

export type ReadContext = (file: ChangedFile) => Promise<string>;
type S = { key: string; patch?: string; note?: string };

// base 대비 diff. readContext 가 있으면(로컬 리뷰) 파일 전체를 펼칠 수 있다 — 화면만 바꾸고, 판정에 쓰는 file.patch 는 그대로다.
// 줄 번호가 원래 diff 와 같아 질문 좌표·남의 줄 표시를 그대로 쓴다. contextKey 가 바뀌면(새 커밋) 다시 읽는다
export function BaseDiff({ file, ask, others, readContext, contextKey }: { file: ChangedFile; ask?: DiffAsk; others?: ReadonlySet<number>; readContext?: ReadContext; contextKey?: string }) {
  const [on, setOn] = useState(false);
  const [s, setS] = useState<S | null>(null);
  // 새 파일·삭제 파일은 diff 가 곧 파일 전체다. hunk 가 없으면(바이너리·내용 그대로인 이름 변경) 보일 줄이 없다
  const can = !!readContext && file.status !== 'added' && file.status !== 'removed' && !!file.patch?.startsWith('@@ ');
  const key = `${contextKey ?? ''}\n${file.path}`;
  useEffect(() => {
    if (!on || !can) return;
    let live = true;
    readContext!(file).then(
      (patch) => { if (live) setS(patch.split('\n').length > MAX_LINES ? { key, note: t.contextTooBig } : { key, patch }); },
      () => { if (live) setS({ key, note: t.contextFailed }); },
    );
    return () => { live = false; };
  }, [on, can, key]);
  const now = on && s?.key === key ? s : null;   // 옛 커밋 것은 안 보인다 — 새로 읽는 동안은 지금 diff
  return (
    <>
      {can && (
        <div className="context-bar">
          <button type="button" data-testid="context-toggle" aria-pressed={on} onClick={() => { setOn((v) => !v); setS(null); }}>{on ? t.contextOff : t.contextOn}</button>
          {on && !now && <span className="context-note">{t.loading}</span>}
          {now?.note && <span data-testid="context-note" role="status" className="context-note">{now.note}</span>}
        </div>
      )}
      <DiffView patch={now?.patch ?? file.patch} ask={ask} others={others} />
    </>
  );
}
