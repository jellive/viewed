export async function hmacHex(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// GitHub 은 owner/repo 대소문자를 구분하지 않지만 브랜치·경로는 구분한다
export function recordKey(secret: string, owner: string, repo: string, branch: string, path: string): Promise<string> {
  return hmacHex(secret, JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), branch, path]));
}
