import { describe, it, expect } from 'vitest';
import { fileContextPatch } from '../src/local';

// 파일 하나만 문맥을 넓혀 다시 읽은 git 출력 → DiffView 에 넘길 hunk 문자열
describe('fileContextPatch', () => {
  it('keeps only the hunks of the one file, without the header or the trailing newline', () => {
    const out = 'diff --git a/f.ts b/f.ts\nindex 1..2 100644\n--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
    expect(fileContextPatch(out)).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
  });

  it('keeps the rename header out too', () => {
    const out = 'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n';
    expect(fileContextPatch(out)).toBe('@@ -1 +1 @@\n-a\n+b');
  });

  it('has nothing to show for an empty result, a binary file, or anything but one file', () => {
    expect(fileContextPatch('')).toBeUndefined();
    expect(fileContextPatch('diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n')).toBeUndefined();
    const one = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(fileContextPatch(one('a.ts') + one('b.ts'))).toBeUndefined();
  });
});
