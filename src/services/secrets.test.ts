import crypto from 'node:crypto';
import { encrypt, decrypt } from './secrets.js';

const KEY_LENGTH = 32;

describe('encrypt/decrypt', () => {
  const testKey = crypto.randomBytes(KEY_LENGTH);

  it('round-trips simple text', () => {
    const plaintext = 'hello world';
    const encrypted = encrypt(plaintext, testKey);
    const decrypted = decrypt(encrypted, testKey);
    expect(decrypted).toBe(plaintext);
  });

  it('round-trips empty string', () => {
    const plaintext = '';
    const encrypted = encrypt(plaintext, testKey);
    const decrypted = decrypt(encrypted, testKey);
    expect(decrypted).toBe(plaintext);
  });

  it('round-trips unicode text', () => {
    const plaintext = '你好世界 🌍 مرحبا';
    const encrypted = encrypt(plaintext, testKey);
    const decrypted = decrypt(encrypted, testKey);
    expect(decrypted).toBe(plaintext);
  });

  it('round-trips JSON data', () => {
    const plaintext = JSON.stringify({ apiKey: 'sk-secret-key', token: '12345' });
    const encrypted = encrypt(plaintext, testKey);
    const decrypted = decrypt(encrypted, testKey);
    expect(decrypted).toBe(plaintext);
    expect(JSON.parse(decrypted)).toEqual({ apiKey: 'sk-secret-key', token: '12345' });
  });

  it('round-trips long text', () => {
    const plaintext = 'a'.repeat(10000);
    const encrypted = encrypt(plaintext, testKey);
    const decrypted = decrypt(encrypted, testKey);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (IV is random)', () => {
    const plaintext = 'same message';
    const encrypted1 = encrypt(plaintext, testKey);
    const encrypted2 = encrypt(plaintext, testKey);
    expect(encrypted1).not.toBe(encrypted2);
    // But both decrypt to same value
    expect(decrypt(encrypted1, testKey)).toBe(plaintext);
    expect(decrypt(encrypted2, testKey)).toBe(plaintext);
  });

  it('encrypted format contains iv:authTag:ciphertext', () => {
    const plaintext = 'test';
    const encrypted = encrypt(plaintext, testKey);
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
    // IV is 16 bytes = 32 hex chars
    expect(parts[0].length).toBe(32);
    // Auth tag is 16 bytes = 32 hex chars
    expect(parts[1].length).toBe(32);
    // Ciphertext is non-empty
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it('fails to decrypt with wrong key', () => {
    const plaintext = 'secret message';
    const encrypted = encrypt(plaintext, testKey);
    const wrongKey = crypto.randomBytes(KEY_LENGTH);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const plaintext = 'secret message';
    const encrypted = encrypt(plaintext, testKey);
    const parts = encrypted.split(':');
    // Tamper with the ciphertext by incrementing the first byte (guarantees change)
    const firstByte = parseInt(parts[2].slice(0, 2), 16);
    const tamperedByte = ((firstByte + 1) % 256).toString(16).padStart(2, '0');
    const tamperedCiphertext = tamperedByte + parts[2].slice(2);
    const tampered = `${parts[0]}:${parts[1]}:${tamperedCiphertext}`;
    expect(() => decrypt(tampered, testKey)).toThrow();
  });

  it('fails to decrypt tampered auth tag', () => {
    const plaintext = 'secret message';
    const encrypted = encrypt(plaintext, testKey);
    const parts = encrypted.split(':');
    // Tamper with the auth tag by incrementing the first byte (guarantees change)
    const firstByte = parseInt(parts[1].slice(0, 2), 16);
    const tamperedByte = ((firstByte + 1) % 256).toString(16).padStart(2, '0');
    const tamperedAuthTag = tamperedByte + parts[1].slice(2);
    const tampered = `${parts[0]}:${tamperedAuthTag}:${parts[2]}`;
    expect(() => decrypt(tampered, testKey)).toThrow();
  });
});
