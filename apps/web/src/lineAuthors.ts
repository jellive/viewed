import { useEffect, useMemo, useState } from 'react';
import type { Author } from '@viewed/core';
import { localBlame, type LineBlame } from './localSource';
import { createQueue } from './blameQueue';

export type BlameSrc = { repo: string; head: string; mergeBase: string; isMe: (a: Author) => boolean };
type Blame = LineBlame;
type Entry = { p: Promise<Blame | null>; refs: number };

const queue = createQueue(4);   // 앱 전체 동시 blame — 큰 리뷰가 git 프로세스를 줄줄이 띄우지 않게
const CAP = 200;
const cache = new Map<string, Entry>();   // 삽입 순서 = 최근 사용 순서(쓰면 뒤로)

// 키에 repo·mergeBase 가 든다 — 다른 폴더의 같은 sha(포크·복제)나 같은 head 의 다른 base(경계 null 이 달라짐)를 섞지 않는다
const keyOf = (s: { repo: string; head: string; mergeBase: string }, path: string) => `${s.repo}\0${s.head}\0${s.mergeBase}\0${path}`;

function evict(src: BlameSrc) {
  const cur = `${src.repo}\0${src.head}\0${src.mergeBase}\0`;
  for (const [k, e] of cache) if (e.refs === 0 && !k.startsWith(cur)) cache.delete(k);   // 다른 리뷰의 것
  for (const [k, e] of cache) { if (cache.size <= CAP) break; if (e.refs === 0) cache.delete(k); }   // 가장 오래된 것부터
}

function acquire(src: BlameSrc, path: string): { key: string; entry: Entry } {
  const key = keyOf(src, path);
  let entry = cache.get(key);
  if (entry) { cache.delete(key); cache.set(key, entry); }
  else {
    const e: Entry = { refs: 0, p: undefined as unknown as Promise<Blame | null> };
    e.p = queue.enqueue(() => localBlame(src.repo, src.head, path, src.mergeBase), () => e.refs === 0).then((r) => {
      if (r === null && cache.get(key) === e) cache.delete(key);   // 실패·취소는 남기지 않는다 — 다시 펼치면 새로 시도
      return r;
    });
    cache.set(key, e); entry = e;
  }
  entry.refs++;
  evict(src);   // refs 를 올린 뒤에 — 방금 넣은 항목이 쫓겨나지 않게
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
    if (!blame || !repo || !head || !isMe || !mb || blame.key !== keyOf({ repo, head, mergeBase: mb }, path)) return undefined;
    const s = new Set<number>();
    // 남의 줄 = 두 blame 이 모두 남이라고 할 때만. 한쪽이라도 나(또는 경계·모름)면 내 것
    blame.v.plain.forEach((a, i) => { const b = blame.v.moved[i]; if (a && b && !isMe(a) && !isMe(b)) s.add(i + 1); });
    return s;
  }, [blame, repo, head, mb, path, isMe]);
}
