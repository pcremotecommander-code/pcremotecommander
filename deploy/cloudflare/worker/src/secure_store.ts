/** Encrypt sensitive short-lived records before Durable Object persistence. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

async function keyFor(secret: string, accountId: string, purpose: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('pc-remote-commander/store/v1'),
    info: encoder.encode(`${purpose}:${accountId}`),
  }, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}

export type SealedRecord = {v: 1; iv: string; ciphertext: string; expires: number};

export async function sealRecord(secret: string, accountId: string, purpose: string, value: Record<string, unknown>, expires: number): Promise<SealedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(secret, accountId, purpose);
  const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(`${purpose}:${accountId}:${expires}`)}, key, encoder.encode(JSON.stringify(value)));
  return {v: 1, iv: base64url(iv), ciphertext: base64url(new Uint8Array(encrypted)), expires};
}

export async function openRecord<T>(secret: string, accountId: string, purpose: string, item: SealedRecord): Promise<T> {
  if (item.v !== 1 || !Number.isFinite(item.expires)) throw new Error('Invalid sealed record');
  const iv = fromBase64url(item.iv);
  if (iv.length !== 12) throw new Error('Invalid sealed record');
  const key = await keyFor(secret, accountId, purpose);
  const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(`${purpose}:${accountId}:${item.expires}`)}, key, fromBase64url(item.ciphertext));
  return JSON.parse(decoder.decode(plaintext)) as T;
}
