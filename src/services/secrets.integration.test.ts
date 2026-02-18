import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import crypto from 'node:crypto';

// Mock functions
const mockGetPassword = jest.fn<(service: string, account: string) => Promise<string | null>>();
const mockSetPassword =
  jest.fn<(service: string, account: string, password: string) => Promise<void>>();
const mockDeletePassword = jest.fn<(service: string, account: string) => Promise<boolean>>();

const mockMkdir =
  jest.fn<(path: string, options?: { recursive?: boolean }) => Promise<string | undefined>>();
const mockReadFile = jest.fn<(path: string, encoding?: string) => Promise<string>>();
const mockWriteFile = jest.fn<(path: string, data: string, options?: object) => Promise<void>>();
const mockUnlink = jest.fn<(path: string) => Promise<void>>();

// Mock modules BEFORE importing module under test
jest.unstable_mockModule('keytar', () => ({
  getPassword: mockGetPassword,
  setPassword: mockSetPassword,
  deletePassword: mockDeletePassword,
}));

// Services use: import { promises as fs } from 'node:fs'
jest.unstable_mockModule('node:fs', () => ({
  promises: {
    mkdir: mockMkdir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    unlink: mockUnlink,
  },
}));

// Dynamic imports AFTER mocking
const { storeSecret, getSecret, deleteSecret, hasSecret, encrypt, decrypt } =
  await import('./secrets.js');

describe('secrets.ts integration', () => {
  const testKey = crypto.randomBytes(32);

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: keytar works normally
    mockGetPassword.mockResolvedValue(null);
    mockSetPassword.mockResolvedValue(undefined);
    mockDeletePassword.mockResolvedValue(true);
  });

  describe('storeSecret', () => {
    it('stores in keytar when available', async () => {
      await storeSecret('test-service', 'test-key', 'secret-value');

      expect(mockSetPassword).toHaveBeenCalledWith(
        'clawdult-test-service',
        'test-key',
        'secret-value'
      );
    });
  });

  describe('getSecret', () => {
    it('retrieves from keytar when available', async () => {
      mockGetPassword.mockResolvedValue('stored-secret');

      const result = await getSecret('test-service', 'test-key');

      expect(result).toBe('stored-secret');
      expect(mockGetPassword).toHaveBeenCalledWith('clawdult-test-service', 'test-key');
    });

    it('returns null when secret not found in keytar', async () => {
      mockGetPassword.mockResolvedValue(null);
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await getSecret('test-service', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('deleteSecret', () => {
    it('calls keytar deletePassword', async () => {
      mockUnlink.mockResolvedValue(undefined);

      await deleteSecret('test-service', 'test-key');

      expect(mockDeletePassword).toHaveBeenCalledWith('clawdult-test-service', 'test-key');
    });

    it('also attempts to delete file', async () => {
      mockUnlink.mockResolvedValue(undefined);

      await deleteSecret('test-service', 'test-key');

      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('test-service-test-key.enc'));
    });

    it('ignores errors from both sources gracefully', async () => {
      mockDeletePassword.mockRejectedValue(new Error('Not found'));
      mockUnlink.mockRejectedValue({ code: 'ENOENT' });

      await expect(deleteSecret('test-service', 'test-key')).resolves.toBeUndefined();
    });
  });

  describe('hasSecret', () => {
    it('returns true when secret exists in keytar', async () => {
      mockGetPassword.mockResolvedValue('exists');

      const result = await hasSecret('test-service', 'test-key');

      expect(result).toBe(true);
    });

    it('returns false when secret not found', async () => {
      mockGetPassword.mockResolvedValue(null);
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await hasSecret('test-service', 'nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('encrypt/decrypt', () => {
    it('round-trips a value', () => {
      const plaintext = 'my secret value';
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const plaintext = 'same message';
      const encrypted1 = encrypt(plaintext, testKey);
      const encrypted2 = encrypt(plaintext, testKey);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('fails with corrupted data', () => {
      const encrypted = encrypt('test', testKey);
      const corrupted = encrypted.replace(/[a-f]/g, 'x');

      expect(() => decrypt(corrupted, testKey)).toThrow();
    });

    it('fails with wrong key', () => {
      const encrypted = encrypt('test', testKey);
      const wrongKey = crypto.randomBytes(32);

      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });
  });
});
