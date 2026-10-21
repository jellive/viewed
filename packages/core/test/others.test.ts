import { describe, it, expect } from 'vitest';
import { meMatcher, othersOf, type Author } from '../src/others';
import type { ChangedFile } from '../src/types';

const f = (path: string, previousPath?: string): ChangedFile =>
  ({ path, ...(previousPath ? { previousPath } : {}), status: 'modified', blobSha: 'x' });
const alice: Author = ['Alice', 'alice@example.test'];
const bob: Author = ['Bob', 'bob@example.test'];

describe('meMatcher', () => {
  it('matches everything when no ids', () => {
    expect(meMatcher([])(bob)).toBe(true);
    expect(meMatcher(['', '  '])(bob)).toBe(true);
  });
  it('ignores case and whitespace, by name or email', () => {
    expect(meMatcher([' ALICE '])(alice)).toBe(true);
    expect(meMatcher(['Alice@Example.test'])(alice)).toBe(true);
    expect(meMatcher(['alice'])(bob)).toBe(false);
  });
});

describe('othersOf', () => {
  const isMe = meMatcher(['alice@example.test']);
  it('only bob -> others', () => {
    expect(othersOf([f('a.ts')], { 'a.ts': [bob] }, isMe).get('a.ts')).toEqual(['Bob']);
  });
  it('dedupes names in first-seen order', () => {
    const carol: Author = ['Carol', 'carol@example.test'];
    expect(othersOf([f('a.ts')], { 'a.ts': [bob, carol, ['Bob', 'bob2@example.test']] }, isMe).get('a.ts')).toEqual(['Bob', 'Carol']);
  });
  it('alice mixed in -> not others', () => {
    expect(othersOf([f('a.ts')], { 'a.ts': [bob, alice] }, isMe).has('a.ts')).toBe(false);
  });
  it('no authors -> not others', () => {
    expect(othersOf([f('a.ts')], {}, isMe).has('a.ts')).toBe(false);
    expect(othersOf([f('a.ts')], { 'a.ts': [] }, isMe).has('a.ts')).toBe(false);
  });
  it('alice on previousPath -> not others', () => {
    expect(othersOf([f('n.ts', 'o.ts')], { 'n.ts': [bob], 'o.ts': [alice] }, isMe).has('n.ts')).toBe(false);
    expect(othersOf([f('n.ts', 'o.ts')], { 'n.ts': [bob], 'o.ts': [bob] }, isMe).get('n.ts')).toEqual(['Bob']);
  });
  it('prototype-named paths neither crash nor inherit', () => {
    const authors = JSON.parse('{"__proto__":[["Bob","bob@example.test"]]}') as Record<string, Author[]>;
    const m = othersOf([f('constructor'), f('toString'), f('__proto__')], authors, isMe);
    expect(m.has('constructor')).toBe(false);
    expect(m.has('toString')).toBe(false);
    expect(m.get('__proto__')).toEqual(['Bob']);
  });
});
