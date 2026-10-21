import { useEffect, useMemo, useState } from 'react';
import type { Author } from '@viewed/core';
import { localBlame } from './localSource';

export type BlameSrc = { repo: string; head: string; mergeBase: string; isMe: (a: Author) => boolean };
type Blame = (Author | null)[];
type Entry = { p: Promise<Blame | null>; refs: number };

const MAX = 4;   // 앱 전체 동시 blame — 큰 리뷰가 git 프로세스를 줄줄이 띄우지 않게
let running = 0;
const waiting: (() => void)[] = [];
const cache = new Map<string, Entry>();

function slot<T>(job: () => Promise<T>, skip: () => boolean, skipped: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const run = async () => {   // 호출 전에 자리(running)를 이미 잡았다
      try { resolve(skip() ? skipped : await job()); }   // 기다리는 사이 접혀서 아무도 안 보면 안 돈다
      finally { running--; const next = waiting.shift(); if (next) { running++; next(); } }
    };
    // 자리는 동기로 잡고 시작만 마이크로태스크로 미룬다 — 만든 쪽이 refs 를 올린 뒤에 skip() 이 읽혀야 한다
    if (running < MAX) { running++; queueMicrotask(() => void run()); } else waiting.push(() => void run());
  });
}

function acquire(src: BlameSrc, path: string): { key: string; entry: Entry } {
  const key = `${src.head}\0${path}`;
  let entry = cache.get(key);
  if (!entry) {
    const e: Entry = { refs: 0, p: undefined as unknown as Promise<Blame | null> };
    e.p = slot(() => localBlame(src.repo, src.head, path, src.mergeBase), () => e.refs === 0, null).then((r) => {
      if (r === null && cache.get(key) === e) cache.delete(key);   // 실패·취소는 남기지 않는다 — 다시 펼치면 새로 시도
      return r;
    });
    cache.set(key, e); entry = e;
  }
  entry.refs++;
  return { key, entry };
}

// 펼쳐진(렌더된) diff 가 부른다. head 줄 번호 중 작성자가 있고 '나'가 아닌 것. 대기 중·실패·로컬 모드가 아니면 undefined
export function useOtherLines(src: BlameSrc | undefined, path: string): ReadonlySet<number> | undefined {
  const [blame, setBlame] = useState<{ key: string; v: Blame } | null>(null);
  const repo = src?.repo, head = src?.head, mb = src?.mergeBase;
  useEffect(() => {
    if (!repo || !head || !mb) return;
    const { key, entry } = acquire({ repo, head, mergeBase: mb, isMe: () => false }, path);
    let live = true;
    void entry.p.then((v) => { if (live && v) setBlame({ key, v }); });
    return () => { live = false; entry.refs--; };
  }, [repo, head, mb, path]);
  const isMe = src?.isMe;
  return useMemo(() => {
    if (!blame || !head || !isMe || blame.key !== `${head}\0${path}`) return undefined;
    const s = new Set<number>();
    blame.v.forEach((a, i) => { if (a && !isMe(a)) s.add(i + 1); });
    return s;
  }, [blame, head, path, isMe]);
}
