const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function hash(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hash(a), hash(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
async function key(secret: string) {
  const bytes = decode(secret);
  if (bytes.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must contain 32 bytes');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(value: string, secret: string, owner = 'default'): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`docs-demo:${owner}:v1`) }, await key(secret), encoder.encode(value));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function decrypt(value: string, secret: string, owner = 'default'): Promise<string> {
  const [version, iv, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !ciphertext) throw new Error('Invalid encrypted token');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: encoder.encode(`docs-demo:${owner}:v1`) }, await key(secret), decode(ciphertext)));
}
