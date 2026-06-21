function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

async function deriveKey(raw: string): Promise<CryptoKey> {
  const keyData = /^[0-9a-fA-F]{64}$/.test(raw)
    ? fromHex(raw)
    : new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  return crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(text: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return `${toHex(iv)}:${toHex(encrypted)}`;
}

export async function decrypt(encryptedText: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const [ivHex, dataHex] = encryptedText.split(':');
  const iv = fromHex(ivHex);
  const data = fromHex(dataHex);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}
