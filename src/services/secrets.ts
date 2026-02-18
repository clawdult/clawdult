import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const SECRETS_DIR = path.join(os.homedir(), '.clawdult', 'secrets');
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

let keytar: typeof import('keytar') | null = null;

async function getKeytar(): Promise<typeof import('keytar') | null> {
  if (keytar !== null) {
    return keytar;
  }
  try {
    const mod = await import('keytar');
    keytar = (mod as { default?: typeof import('keytar') }).default ?? mod;
    return keytar;
  } catch {
    return null;
  }
}

async function getEncryptionKey(): Promise<Buffer> {
  const kt = await getKeytar();

  if (kt) {
    try {
      let key = await kt.getPassword('clawdult', 'encryption-key');
      if (!key) {
        // Check for existing file-based key before generating a new one
        const keyPath = path.join(SECRETS_DIR, '.key');
        try {
          key = (await fs.readFile(keyPath, 'utf-8')).trim();
        } catch {
          key = crypto.randomBytes(KEY_LENGTH).toString('hex');
        }
        await kt.setPassword('clawdult', 'encryption-key', key);
      }
      return Buffer.from(key, 'hex');
    } catch (error) {
      console.warn(
        'clawdult: keychain unavailable, using file-based encryption:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Fallback to file-based key
  const keyPath = path.join(SECRETS_DIR, '.key');
  try {
    const keyHex = await fs.readFile(keyPath, 'utf-8');
    return Buffer.from(keyHex.trim(), 'hex');
  } catch {
    await fs.mkdir(SECRETS_DIR, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(KEY_LENGTH);
    await fs.writeFile(keyPath, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

export function encrypt(text: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf-8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string, key: Buffer): string {
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}

export async function storeSecret(service: string, key: string, value: string): Promise<void> {
  const kt = await getKeytar();

  if (kt) {
    try {
      await kt.setPassword(`clawdult-${service}`, key, value);
      return;
    } catch (error) {
      console.warn(
        'clawdult: keychain store failed, using file fallback:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Fallback to encrypted file storage
  await fs.mkdir(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const encKey = await getEncryptionKey();
  const encrypted = encrypt(value, encKey);
  const secretPath = path.join(SECRETS_DIR, `${service}-${key}.enc`);
  await fs.writeFile(secretPath, encrypted, { mode: 0o600 });
}

export async function getSecret(service: string, key: string): Promise<string | null> {
  const kt = await getKeytar();

  if (kt) {
    try {
      const value = await kt.getPassword(`clawdult-${service}`, key);
      if (value) {
        return value;
      }
    } catch (error) {
      console.warn(
        'clawdult: keychain read failed, trying file fallback:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Try encrypted file storage
  const secretPath = path.join(SECRETS_DIR, `${service}-${key}.enc`);
  try {
    const encrypted = await fs.readFile(secretPath, 'utf-8');
    const encKey = await getEncryptionKey();
    return decrypt(encrypted.trim(), encKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        'clawdult: failed to read encrypted secret:',
        error instanceof Error ? error.message : String(error)
      );
    }
    return null;
  }
}

export async function deleteSecret(service: string, key: string): Promise<void> {
  const kt = await getKeytar();

  if (kt) {
    try {
      await kt.deletePassword(`clawdult-${service}`, key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('not found') && !message.includes('No password')) {
        console.warn('clawdult: keychain delete failed:', message);
      }
    }
  }

  // Also try to delete encrypted file
  const secretPath = path.join(SECRETS_DIR, `${service}-${key}.enc`);
  try {
    await fs.unlink(secretPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        'clawdult: failed to delete encrypted secret:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

export async function hasSecret(service: string, key: string): Promise<boolean> {
  const value = await getSecret(service, key);
  return value !== null;
}

export interface SecretCredentials {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
}

export async function storeCredentials(
  service: string,
  credentials: SecretCredentials
): Promise<void> {
  const json = JSON.stringify(credentials);
  await storeSecret(service, 'credentials', json);
}

export async function getCredentials(service: string): Promise<SecretCredentials | null> {
  const json = await getSecret(service, 'credentials');
  if (!json) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
