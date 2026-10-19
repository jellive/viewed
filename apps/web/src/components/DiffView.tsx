import { t } from '../i18n';

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

// seen: patch 를 \n 으로 나눈 줄 번호 중 이미 확인한 블록의 줄 — 흐리게 그린다
export function DiffView({ patch, seen }: { patch?: string; seen?: ReadonlySet<number> }) {
  if (patch === undefined) return <p data-testid="no-patch" className="note">{t.noPatch}</p>;
  return (
    <pre data-testid="diff" className="diff">
      {lines(patch).map((l, i) => (
        <div key={i} className={`ln ${l.kind}${seen?.has(i) ? ' seen' : ''}`} data-o={l.o ?? ''} data-n={l.n ?? ''}>
          {l.kind === 'hunk' || l.kind === 'meta'
            ? <span className="code">{l.text}</span>
            : <span className="code"><span className="mk">{l.text.slice(0, 1)}</span>{l.text.slice(1)}</span>}
        </div>
      ))}
    </pre>
  );
}
