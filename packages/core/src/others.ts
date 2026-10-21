import type { ChangedFile } from './types';

export type Author = [name: string, email: string];

const norm = (s: string) => s.trim().toLowerCase();

// ids 와 작성자 이름·이메일을 비교한다. 남은 id 가 없으면 전부 내 것(아무것도 흐리지 않는다)
export function meMatcher(ids: string[]): (a: Author) => boolean {
  const set = new Set(ids.map(norm).filter((x) => x !== ''));
  if (set.size === 0) return () => true;
  return ([name, email]) => set.has(norm(name)) || set.has(norm(email));
}

// 키는 file.path. 작성자 = authors[path] ∪ authors[previousPath]. 비었거나 '나'가 하나라도 있으면 맵에 없다
export function othersOf(files: ChangedFile[], authors: Record<string, Author[]>, isMe: (a: Author) => boolean): Map<string, string[]> {
  const own = (p: string): Author[] => (Object.hasOwn(authors, p) ? authors[p] : []);
  const out = new Map<string, string[]>();
  for (const file of files) {
    const all = [...own(file.path), ...(file.previousPath ? own(file.previousPath) : [])];
    if (all.length === 0 || all.some(isMe)) continue;
    out.set(file.path, [...new Set(all.map(([name]) => name))]);
  }
  return out;
}
