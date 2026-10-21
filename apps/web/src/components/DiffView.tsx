import { Fragment } from 'react';
import { t } from '../i18n';
import type { DiffAsk, Side } from '../ask';

type Line = { kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'; o?: number; n?: number; text: string };

// hunk 머리(@@ -a,b +c,d @@)에서 줄번호를 이어 센다. 번호는 data-* 로만 넘겨 CSS 가 그린다 — 텍스트에 섞지 않는다
function lines(patch: string): Line[] {
  let o = 0, n = 0;
  // 끝 개행이 만드는 빈 항목은 줄이 아니다
  const raw = patch.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  return raw.map((text): Line => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (m) { o = Number(m[1]); n = Number(m[2]); return { kind: 'hunk', text }; }
    if (text.startsWith('+')) return { kind: 'add', n: n++, text };
    if (text.startsWith('-')) return { kind: 'del', o: o++, text };
    if (text.startsWith('\\')) return { kind: 'meta', text };
    return { kind: 'ctx', o: o++, n: n++, text };
  });
}

// 질문할 좌표: 추가·문맥 줄은 head 쪽(R, 새 번호), 삭제 줄은 merge-base 쪽(L, 옛 번호)이고 allowDel 일 때만. hunk 머리·\ 줄엔 없다
function target(l: Line, ask?: DiffAsk): { side: Side; line: number } | null {
  if (!ask) return null;
  if ((l.kind === 'add' || l.kind === 'ctx') && l.n !== undefined) return { side: 'R', line: l.n };
  if (l.kind === 'del' && ask.allowDel && l.o !== undefined) return { side: 'L', line: l.o };
  return null;
}

// seen: patch 를 \n 으로 나눈 줄 번호 중 이미 확인한 블록의 줄 — 흐리게 그린다
// ask: 있으면 줄마다 + 를 달고, 그 줄의 스레드를 줄 바로 다음에 그린다
// others: 남이 쓴 head 줄 번호 — 추가 줄만 바탕을 입힌다(삭제·문맥 줄은 아니다)
export function DiffView({ patch, seen, ask, others }: { patch?: string; seen?: ReadonlySet<number>; ask?: DiffAsk; others?: ReadonlySet<number> }) {
  if (patch === undefined) return <p data-testid="no-patch" className="note">{t.noPatch}</p>;
  return (
    <pre data-testid="diff" className="diff">
      {lines(patch).map((l, i) => {
        const at = target(l, ask);
        const key = at && ask!.keyOf(at.side, at.line);
        return (
          <Fragment key={i}>
            <div className={`ln ${l.kind}${seen?.has(i) ? ' seen' : ''}${l.kind === 'add' && l.n !== undefined && others?.has(l.n) ? ' other' : ''}`} data-o={l.o ?? ''} data-n={l.n ?? ''}>
              {l.kind === 'hunk' || l.kind === 'meta'
                ? <span className="code">{l.text}</span>
                : <span className="code">
                    {at && <button type="button" data-testid="ask-btn" className="ask-btn" aria-label={t.askLine} title={t.askLine}
                      onClick={() => ask!.open(at.side, at.line, l.text.slice(1))}>
                      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    </button>}
                    <span className="mk">{l.text.slice(0, 1)}</span>{l.text.slice(1)}
                  </span>}
            </div>
            {key && ask!.thread(key)}
          </Fragment>
        );
      })}
    </pre>
  );
}
