import { describe, it, expect } from 'vitest';
import { recordKey } from '../src/keys';

describe('recordKey', () => {
  it('ignores owner/repo letter case (GitHub is case-insensitive there)', async () => {
    expect(await recordKey('s', 'Acme', 'Widget', 'feat', 'a.ts')).toBe(await recordKey('s', 'acme', 'widget', 'feat', 'a.ts'));
  });
  it('keeps branch and path case significant', async () => {
    const base = await recordKey('s', 'acme', 'widget', 'feat', 'a.ts');
    expect(await recordKey('s', 'acme', 'widget', 'Feat', 'a.ts')).not.toBe(base);
    expect(await recordKey('s', 'acme', 'widget', 'feat', 'A.ts')).not.toBe(base);
  });
});
