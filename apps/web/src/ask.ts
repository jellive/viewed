import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReviewItem, Snapshot } from '@viewed/core';
import { lang } from './i18n';
import { Thread } from './components/Thread';

// 데스크톱 main 과 같은 모양(apps/desktop/ask/index.cjs 의 JSDoc)
export type Side = 'L' | 'R';   // L = merge-base 쪽(삭제 줄), R = head 쪽(추가·문맥 줄)
export interface AskRequest { id: string; repo: string; head: string; mergeBase?: string; path: string; previousPath?: string;
  side: Side; line: number; lineText: string; question: string; history: { q: string; a: string }[]; lang: 'ko' | 'en' }
export type AskSource = { kind: 'session'; sessionId: string; at: number; subagent: boolean }
  | { kind: 'none'; reason: 'short-line' | 'not-found' | 'mixed' | 'no-human' | 'timeout' | 'no-time' | 'unreadable' };
export type AskError = 'cancelled' | 'timeout' | 'not-installed' | 'too-old' | 'login' | 'invalid' | 'failed';
export type AskResult = { ok: true; answer: string; source: AskSource; account: string | null }
  | { ok: false; error: AskError; message?: string };
export type AskStage = 'queued' | 'searching' | 'answering';
export interface DesktopAsk { start(req: AskRequest): Promise<AskResult>; cancel(id: string): Promise<void>; onProgress(cb: (p: { id: string; stage: AskStage }) => void): () => void }

export type View = 'full' | 'since-blocks' | 'since-blob';
export interface DiffAsk { allowDel: boolean; keyOf(side: Side, line: number): string; open(side: Side, line: number, text: string): void; thread(key: string): ReactNode }

export type Turn = { q: string; a: string; source: AskSource; account: string | null };
type Coord = { path: string; previousPath?: string; side: Side; line: number; lineText: string };
export interface ThreadData {
  coord: Coord;
  turns: Turn[];
  pending?: { id: string; q: string; stage: AskStage };
  failed?: { q: string; error: AskError; message?: string };
  want: boolean;   // 입력칸에 포커스를 줘야 한다 — + 를 누르면 켜지고 Thread 가 포커스를 준 뒤 끈다(접었다 펴서 다시 그릴 땐 안 뺏는다)
}

// main 의 한도(이전 문답 3쌍, 한 항목 4000자) — 넘기면 요청이 통째로 거부된다
const PAIRS = 3, ITEM = 4000;

// 스레드 저장소 — ReviewView 높이에 두어 접기·필터로 diff 가 unmount 돼도 남는다(spec §10).
// repo(로컬로 열기에 성공한 리뷰의 폴더)와 bridge 가 둘 다 있을 때만 + 를 그린다
export function useThreads({ repo, snap, bridge }: { repo?: string; snap: Snapshot; bridge?: DesktopAsk }) {
  const [threads, setThreads] = useState<Record<string, ThreadData>>({});
  const ref = useRef(threads);
  ref.current = threads;

  // 진행 알림은 한 번만 구독하고 id 로 그 스레드에 단계를 붙인다
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.onProgress(({ id, stage }) => setThreads((ts) => {
      const k = Object.keys(ts).find((x) => ts[x].pending?.id === id);
      return k ? { ...ts, [k]: { ...ts[k], pending: { ...ts[k].pending!, stage } } } : ts;
    }));
    // 리뷰 화면이 사라지면 도는 질문을 끝낸다
    return () => {
      off();
      for (const th of Object.values(ref.current)) if (th.pending) bridge.cancel(th.pending.id).catch(() => {});
    };
  }, [bridge]);

  // 리뷰 정체(repo·head·mergeBase)가 바뀌면 — 실시간 갱신은 같은 id 로 다시 읽어 ReviewView 가 다시 마운트되지 않는다 —
  // 도는 질문을 끝내고 스레드를 비운다(spec §10)
  const identity = `${repo ?? ''}|${snap.headSha}|${snap.mergeBase ?? ''}`;
  const seenIdentity = useRef(identity);
  useEffect(() => {
    if (seenIdentity.current === identity) return;
    seenIdentity.current = identity;
    for (const th of Object.values(ref.current)) if (th.pending) bridge?.cancel(th.pending.id).catch(() => {});
    ref.current = {};
    setThreads({});
  }, [identity, bridge]);

  const patch = (key: string, f: (th: ThreadData) => ThreadData | undefined) => setThreads((ts) => {
    if (!ts[key]) return ts;
    const next = f(ts[key]);
    if (next === ts[key]) return ts;
    const out = { ...ts };
    if (next) out[key] = next; else delete out[key];
    return out;
  });

  function send(key: string, q: string) {
    const th = ref.current[key];
    if (!repo || !bridge || !th || th.pending) return;
    const id = crypto.randomUUID();
    const c = th.coord;
    const req: AskRequest = {
      id, repo, head: snap.headSha, ...(snap.mergeBase ? { mergeBase: snap.mergeBase } : {}),
      path: c.path, ...(c.previousPath !== undefined ? { previousPath: c.previousPath } : {}),
      side: c.side, line: c.line, lineText: c.lineText, question: q,
      history: th.turns.slice(-PAIRS).map((x) => ({ q: x.q.slice(0, ITEM), a: x.a.slice(0, ITEM) })), lang,
    };
    // 미리 ref 도 고친다 — 다시 그리기 전에 한 번 더 보내도 겹치지 않게
    ref.current = { ...ref.current, [key]: { ...th, pending: { id, q, stage: 'queued' }, failed: undefined } };
    patch(key, (t) => ({ ...t, pending: { id, q, stage: 'queued' }, failed: undefined }));
    const settle = (r: AskResult) => patch(key, (t) => {
      // 취소했거나 스레드를 닫았으면 늦게 온 답은 버린다
      if (t.pending?.id !== id) return t;
      if (r.ok) return { ...t, pending: undefined, turns: [...t.turns, { q, a: r.answer, source: r.source, account: r.account }] };
      if (r.error === 'cancelled') return { ...t, pending: undefined };
      return { ...t, pending: undefined, failed: { q, error: r.error, message: r.message } };
    });
    bridge.start(req).then(settle, (e) => settle({ ok: false, error: 'failed', message: String(e) }));
  }

  function cancel(key: string) {
    const id = ref.current[key]?.pending?.id;
    if (!id) return;
    bridge?.cancel(id).catch(() => {});
    patch(key, (t) => (t.pending?.id === id ? { ...t, pending: undefined } : t));
  }

  function close(key: string) {
    cancel(key);
    patch(key, () => undefined);
  }

  function forFile(item: ReviewItem, view: View): DiffAsk | undefined {
    if (!repo || !bridge) return undefined;
    const path = item.file.path, previousPath = item.file.previousPath;
    const keyOf = (side: Side, line: number) => `${repo}|${snap.headSha}|${snap.mergeBase ?? ''}|${view}|${side}|${path}|${line}`;
    return {
      // 삭제 줄은 merge-base 좌표로 묻는다 — 옛 스냅숏(merge-base 없음)·확인 당시 blob 의 줄은 커밋이 확실치 않다(spec §5)
      allowDel: view !== 'since-blob' && !!snap.mergeBase,
      keyOf,
      open(side, line, text) {
        const key = keyOf(side, line);
        setThreads((ts) => (ts[key]
          ? { ...ts, [key]: { ...ts[key], want: true } }
          : { ...ts, [key]: { coord: { path, ...(previousPath !== undefined ? { previousPath } : {}), side, line, lineText: text }, turns: [], want: true } }));
      },
      thread(key) {
        const th = threads[key];
        if (!th) return null;
        return createElement(Thread, { key: `t-${key}`, data: th, onSend: (q: string) => send(key, q), onCancel: () => cancel(key), onClose: () => close(key),
          onFocused: () => patch(key, (t) => (t.want ? { ...t, want: false } : t)) });
      },
    };
  }

  return { forFile };
}
