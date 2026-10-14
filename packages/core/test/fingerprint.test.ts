import { describe, it, expect } from 'vitest';
import { fingerprint } from '../src/fingerprint';
import type { ChangedFile } from '../src/types';

const base: ChangedFile = { path: 'a.ts', status: 'modified', blobSha: 'b1', patch: '@@ -1 +1 @@\n-x\n+y', mode: '100644' };

describe('fingerprint', () => {
  it('is a 64-char hex and stable', async () => {
    const a = await fingerprint(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint({ ...base })).toBe(a);
  });
  it('changes when only the patch changes (base side moved, head blob same)', async () => {
    expect(await fingerprint({ ...base, patch: '@@ -1 +1 @@\n-z\n+y' })).not.toBe(await fingerprint(base));
  });
  it('changes when only the mode changes', async () => {
    expect(await fingerprint({ ...base, mode: '100755' })).not.toBe(await fingerprint(base));
  });
  it('changes when only the status changes', async () => {
    expect(await fingerprint({ ...base, status: 'added' })).not.toBe(await fingerprint(base));
  });
  it('changes when only the previousPath changes', async () => {
    expect(await fingerprint({ ...base, previousPath: 'old.ts' })).not.toBe(await fingerprint(base));
  });
  it('falls back to blob sha when there is no patch', async () => {
    const noPatch = { ...base, patch: undefined };
    expect(await fingerprint({ ...noPatch, blobSha: 'b2' })).not.toBe(await fingerprint(noPatch));
  });
  it('ignores blob sha when a patch exists', async () => {
    expect(await fingerprint({ ...base, blobSha: 'other' })).toBe(await fingerprint(base));
  });
  it('handles removed files with no blob', async () => {
    expect(await fingerprint({ path: 'gone.ts', status: 'removed', blobSha: null })).toMatch(/^[0-9a-f]{64}$/);
  });
});
