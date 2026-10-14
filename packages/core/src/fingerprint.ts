import type { ChangedFile } from './types';

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// spec §5.2: patch 가 있으면 patch, 없으면 blob sha. 상태·이전 경로·모드를 같이 넣는다.
export function fingerprint(file: ChangedFile): Promise<string> {
  const body = file.patch !== undefined ? `patch:${file.patch}` : `blob:${file.blobSha ?? ''}`;
  return sha256Hex(JSON.stringify([file.status, file.previousPath ?? '', file.mode ?? '', body]));
}
