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

  it('saveOwn writes only this device file', async () => {
    const { f, calls } = gistFetch({});
    await saveOwn(new GitHub('t', f), 'g1', 'mac', { a: rec('x') });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(Object.keys(body.files)).toEqual([deviceFileName('mac')]);
  });
});
