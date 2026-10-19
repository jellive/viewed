import { describe, it, expect } from 'vitest';
import { mergeStates, loadAll, saveOwn, deviceFileName } from '../src/sync';
import { GitHub, type FetchLike } from '../src/github';
import type { ViewRecord } from '../src/types';

const rec = (at: string, viewed = true, fp = 'f'): ViewRecord => ({ fp, blob: 'b', head: 'h', at, viewed });

describe('mergeStates', () => {
  it('keeps the later record per key', () => {
    const m = mergeStates([{ k: rec('2026-10-15T01:00:00Z', true, 'old') }, { k: rec('2026-10-15T02:00:00Z', true, 'new') }]);
    expect(m.k.fp).toBe('new');
  });
  it('orders by parsed time, not string (fractional seconds)', () => {
    const m = mergeStates([
      { k: rec('2026-10-15T00:00:00.500Z', true, 'later') },
      { k: rec('2026-10-15T00:00:00Z', true, 'earlier') },
    ]);
    expect(m.k.fp).toBe('later');
    const m2 = mergeStates([
      { k: rec('2026-10-15T00:00:00Z', true, 'earlier') },
      { k: rec('2026-10-15T00:00:00.500Z', true, 'later') },
    ]);
    expect(m2.k.fp).toBe('later');
  });
  it('on equal time an unchecked record wins', () => {
    const t = '2026-10-15T01:00:00Z';
    expect(mergeStates([{ k: rec(t, true) }, { k: rec(t, false) }]).k.viewed).toBe(false);
    expect(mergeStates([{ k: rec(t, false) }, { k: rec(t, true) }]).k.viewed).toBe(false);
  });
  it('unions disjoint keys', () => {
    expect(Object.keys(mergeStates([{ a: rec('x') }, { b: rec('y') }])).sort()).toEqual(['a', 'b']);
  });
});

describe('gist io', () => {
  function gistFetch(files: Record<string, unknown>, raw: Record<string, string> = {}) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/gists/g1')) return new Response(JSON.stringify(init?.method === 'PATCH' ? {} : { files }));
      if (raw[url]) return new Response(raw[url]);
      return new Response('', { status: 404 });
    };
    return { f, calls };
  }

  it('merges every device file and returns this device own state', async () => {
    const { f } = gistFetch({
      'device-mac.json': { content: JSON.stringify({ a: rec('2026-10-15T01:00:00Z') }), truncated: false, raw_url: '' },
      'device-phone.json': { content: JSON.stringify({ b: rec('2026-10-15T01:00:00Z') }), truncated: false, raw_url: '' },
      'README.md': { content: 'not a device file', truncated: false, raw_url: '' },
    });
    const r = await loadAll(new GitHub('t', f), 'g1', 'mac');
    expect(Object.keys(r.merged).sort()).toEqual(['a', 'b']);
    expect(Object.keys(r.own)).toEqual(['a']);
  });

  it('fetches raw_url when a device file is truncated', async () => {
    const full = JSON.stringify({ a: rec('2026-10-15T01:00:00Z') });
    const { f } = gistFetch(
      { 'device-mac.json': { content: full.slice(0, 5), truncated: true, raw_url: 'https://gist.githubusercontent.com/r/1' } },
      { 'https://gist.githubusercontent.com/r/1': full });
    expect(Object.keys((await loadAll(new GitHub('t', f), 'g1', 'mac')).merged)).toEqual(['a']);
  });

  it('a missing own file is an empty state', async () => {
    const { f } = gistFetch({});
    expect(await loadAll(new GitHub('t', f), 'g1', 'mac')).toEqual({ merged: {}, own: {} });
  });

  it('a corrupt device file throws instead of silently dropping records', async () => {
    const { f } = gistFetch({ 'device-mac.json': { content: '{not json', truncated: false, raw_url: '' } });
    await expect(loadAll(new GitHub('t', f), 'g1', 'mac')).rejects.toThrow();
  });

  it('throws when the gist file list is truncated (own file may be missing)', async () => {
    const { f } = gistFetch({ 'device-phone.json': { content: '{}', truncated: false, raw_url: '' } });
    const orig = f;
    const g: FetchLike = async (url, init) => {
      const r = await orig(url, init);
      if (!url.endsWith('/gists/g1') || init?.method === 'PATCH') return r;
      return new Response(JSON.stringify({ ...(await r.json()), truncated: true }));
    };
    await expect(loadAll(new GitHub('t', g), 'g1', 'mac')).rejects.toThrow('gist file list truncated');
  });

  it('rejects shape-invalid records instead of trusting them', async () => {
    const bad = { a: { ...rec('2026-10-15T01:00:00Z'), viewed: 'false' } };
    const { f } = gistFetch({ 'device-mac.json': { content: JSON.stringify(bad), truncated: false, raw_url: '' } });
    await expect(loadAll(new GitHub('t', f), 'g1', 'mac')).rejects.toThrow();
  });

  it('accepts records with and without the block fields', async () => {
    const withBlocks = { ...rec('2026-10-15T01:00:00Z'), blocks: ['0123456789abcdef'], base: 'a'.repeat(40), meta: 'fedcba9876543210' };
    const { f } = gistFetch({ 'device-mac.json': { content: JSON.stringify({ a: withBlocks, b: rec('2026-10-15T01:00:00Z') }), truncated: false, raw_url: '' } });
    expect(Object.keys((await loadAll(new GitHub('t', f), 'g1', 'mac')).merged).sort()).toEqual(['a', 'b']);
  });

  it.each([
    ['blocks not an array', { blocks: 'x' }],
    ['a block not 16 hex', { blocks: ['xyz'] }],
    ['base not a hash', { base: 'main' }],
    ['meta not 16 hex', { meta: 3 }],
  ])('rejects a record whose %s', async (_, extra) => {
    const bad = { a: { ...rec('2026-10-15T01:00:00Z'), ...extra } };
    const { f } = gistFetch({ 'device-mac.json': { content: JSON.stringify(bad), truncated: false, raw_url: '' } });
    await expect(loadAll(new GitHub('t', f), 'g1', 'mac')).rejects.toThrow();
  });

  it('rejects an unparseable at', async () => {
    const bad = { a: { ...rec('not-a-date') } };
    const { f } = gistFetch({ 'device-mac.json': { content: JSON.stringify(bad), truncated: false, raw_url: '' } });
    await expect(loadAll(new GitHub('t', f), 'g1', 'mac')).rejects.toThrow();
  });

  it('saveOwn writes only this device file', async () => {
    const { f, calls } = gistFetch({});
    await saveOwn(new GitHub('t', f), 'g1', 'mac', { a: rec('x') });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(Object.keys(body.files)).toEqual([deviceFileName('mac')]);
  });
});
