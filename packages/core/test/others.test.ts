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
  it('Claude co-authors are not people: not in the badge, and Claude alone is not others', () => {
    const claude: Author = ['Claude Opus 5.5', 'NoReply@Anthropic.com'];
    expect(othersOf([f('a.ts')], { 'a.ts': [bob, claude] }, isMe).get('a.ts')).toEqual(['Bob']);
    expect(othersOf([f('a.ts')], { 'a.ts': [claude] }, isMe).has('a.ts')).toBe(false);
    expect(othersOf([f('a.ts')], { 'a.ts': [alice, claude] }, isMe).has('a.ts')).toBe(false);
  });
  it('a me-list that names Claude still makes Claude-co-authored files mine', () => {
    const claude: Author = ['Claude Opus 5.5', 'noreply@anthropic.com'];
    expect(othersOf([f('a.ts')], { 'a.ts': [bob, claude] }, meMatcher(['noreply@anthropic.com'])).has('a.ts')).toBe(false);
    expect(othersOf([f('n.ts')], { 'o.ts': [claude], 'n.ts': [bob] }, meMatcher(['Claude Opus 5.5']), [['o.ts', 'n.ts']]).has('n.ts')).toBe(false);
  });
  it('prototype-named paths neither crash nor inherit', () => {
    const authors = JSON.parse('{"__proto__":[["Bob","bob@example.test"]]}') as Record<string, Author[]>;
    const m = othersOf([f('constructor'), f('toString'), f('__proto__')], authors, isMe);
    expect(m.has('constructor')).toBe(false);
    expect(m.has('toString')).toBe(false);
    expect(m.get('__proto__')).toEqual(['Bob']);
  });
});

describe('othersOf renames', () => {
  const isMe = meMatcher(['alice@example.test']);
  it('alice created, bob renamed (no previousPath) -> not others', () => {
    const m = othersOf([f('feature-renamed.ts')], { 'feature-renamed.ts': [bob], 'feature.ts': [alice, bob] }, isMe, [['feature.ts', 'feature-renamed.ts']]);
    expect(m.has('feature-renamed.ts')).toBe(false);
  });
  it('A->B (alice) ->C (bob) chain -> not others', () => {
    const m = othersOf([f('c.ts')], { 'a.ts': [alice], 'b.ts': [alice], 'c.ts': [bob] }, isMe, [['a.ts', 'b.ts'], ['b.ts', 'c.ts']]);
    expect(m.has('c.ts')).toBe(false);
  });
  it('rename chain by bob only stays others, with names from the component', () => {
    const carol: Author = ['Carol', 'carol@example.test'];
    const m = othersOf([f('c.ts')], { 'a.ts': [carol], 'c.ts': [bob] }, isMe, [['a.ts', 'c.ts']]);
    expect(m.get('c.ts')).toEqual(['Bob', 'Carol']);
  });
  it('prototype-named rename paths are safe', () => {
    const m = othersOf([f('constructor')], {}, isMe, [['__proto__', 'constructor']]);
    expect(m.has('constructor')).toBe(false);
  });
});
