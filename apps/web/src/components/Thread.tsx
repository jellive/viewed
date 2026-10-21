import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AskSource, ThreadData } from '../ask';
import { t } from '../i18n';

// 답은 텍스트로만 — 백틱으로 감싼 곳만 <code>, HTML·링크는 만들지 않는다. 짝이 안 맞는 마지막 백틱은 글자 그대로
function plain(text: string): ReactNode[] {
  const parts = text.split('`');
  if (parts.length % 2 === 0) parts.splice(-2, 2, `${parts[parts.length - 2]}\`${parts[parts.length - 1]}`);
  return parts.map((s, i) => (i % 2 ? <code key={i}>{s}</code> : s));
}

const pad = (n: number) => String(n).padStart(2, '0');
const when = (ms: number) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sourceText = (s: AskSource) => (s.kind === 'session' ? t.askSourceSession(s.sessionId.slice(0, 8), when(s.at)) : t.askSourceNone);

// 줄 바로 아래에 붙는 문답(GitHub 리뷰 댓글 모양). 진행 중엔 단계와 취소, 실패면 사유와 다시 시도
export function Thread({ data, onSend, onCancel, onClose, onFocused }: { data: ThreadData; onSend: (q: string) => void; onCancel: () => void; onClose: () => void; onFocused: () => void }) {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!data.want) return;
    input.current?.focus();
    onFocused();
  }, [data.want]);
  const { pending, failed } = data;
  const root = useRef<HTMLDivElement>(null);
  // 데스크톱 문구는 한국어 고정이라 아는 사유는 앱 언어로, 'failed' 만 데스크톱이 준 사유를 보인다
  const errText = failed && (failed.error === 'failed' && failed.message ? failed.message : t.askError[failed.error]);
  // 진행 표시는 끝나면 사라지므로, 스레드마다 하나 남는 알림 자리에서 단계·답 도착·실패를 읽어 준다
  const live = pending ? t.askStage[pending.stage] : errText || (data.turns.length ? t.askArrived : '');
  const close = () => {
    // 닫으면 스레드가 사라지므로 그 줄의 + 로 포커스를 돌려준다
    const btn = root.current?.previousElementSibling?.querySelector<HTMLButtonElement>('.ask-btn');
    onClose();
    btn?.focus();
  };
  const submit = () => {
    const q = draft.trim();
    if (!q || pending) return;
    onSend(q);
    setDraft('');
  };
  const question = (q: string) => <p className="thread-q"><b>{t.askYou}</b> {q}</p>;
  return (
    <div data-testid="thread" className="thread" ref={root}>
      <span data-testid="thread-live" className="sr-only" role="status" aria-live="polite">{live}</span>
      {data.turns.map((x, i) => (
        <div key={i} className="turn">
          {question(x.q)}
          <div className="thread-a">
            <p className="thread-meta">
              <span data-testid="thread-source">{sourceText(x.source)}</span>
              <span data-testid="thread-account">{x.account ? t.askAccount(x.account) : t.askAccountUnknown}</span>
            </p>
            <p data-testid="thread-answer" className="answer">{plain(x.a)}</p>
          </div>
        </div>
      ))}
      {pending && (
        <div className="turn">
          {question(pending.q)}
          <div className="thread-progress">
            <span className="spin" aria-hidden="true" />
            <span>{t.askStage[pending.stage]}</span>
            <button type="button" data-testid="thread-cancel" onClick={onCancel}>{t.askCancel}</button>
          </div>
        </div>
      )}
      {failed && (
        <div className="turn">
          {question(failed.q)}
          <div data-testid="thread-error" className="thread-error">
            <span>{errText}</span>
            <button type="button" onClick={() => onSend(failed.q)}>{t.askRetry}</button>
          </div>
        </div>
      )}
      <form className="thread-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea data-testid="thread-input" ref={input} rows={2} maxLength={2000} value={draft}
          aria-label={data.turns.length ? t.askFollowUp : t.askLine}
          placeholder={data.turns.length ? t.askFollowUp : t.askPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && draft === '') { e.preventDefault(); close(); }
            // 한글 조합 중의 Enter 는 글자를 확정할 뿐이다. Shift+Enter 는 줄바꿈
            else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }} />
        <button data-testid="thread-send" className="primary" disabled={!!pending || !draft.trim()}>{t.askSend}</button>
      </form>
    </div>
  );
}
