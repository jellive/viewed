import type { ChangedFile } from './types';

export type Author = [name: string, email: string];

const norm = (s: string) => s.trim().toLowerCase();

// ids 와 작성자 이름·이메일을 비교한다. 남은 id 가 없으면 전부 내 것(아무것도 흐리지 않는다)
export function meMatcher(ids: string[]): (a: Author) => boolean {
  const set = new Set(ids.map(norm).filter((x) => x !== ''));
  if (set.size === 0) return () => true;
  return ([name, email]) => set.has(norm(name)) || set.has(norm(email));
}

// 키는 file.path. 작성자 = 이름 변경으로 이어진 모든 경로(renames 의 연결 요소)와 previousPath 의 작성자 합집합.
// 과하게 합쳐도 '내 파일' 쪽으로만 기운다. 비었거나 '나'가 하나라도 있으면 맵에 없다
export function othersOf(files: ChangedFile[], authors: Record<string, Author[]>, isMe: (a: Author) => boolean,
  renames: [string, string][] = []): Map<string, string[]> {
  const own = (p: string): Author[] => (Object.hasOwn(authors, p) ? authors[p] : []);
  const adj = new Map<string, string[]>();   // Map 이라 prototype 이름 경로도 안전하다
  const link = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); };
  for (const [a, b] of renames) { link(a, b); link(b, a); }
  for (const file of files) if (file.previousPath) { link(file.path, file.previousPath); link(file.previousPath, file.path); }
  const out = new Map<string, string[]>();
  for (const file of files) {
    const seen = new Set([file.path]);
    const stack = [file.path];
    const all: Author[] = [];
    while (stack.length) {
      const p = stack.pop()!;
      all.push(...own(p));
      for (const n of adj.get(p) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    if (all.length === 0 || all.some(isMe)) continue;
    out.set(file.path, [...new Set(all.map(([name]) => name))]);
  }
  return out;
}
