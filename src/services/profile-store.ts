import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export interface ProfileStore<T extends { name: string }> {
  list(): Promise<T[]>;
  get(name: string): Promise<T | null>;
  save(profile: T): Promise<void>;
  delete(name: string): Promise<void>;
}

export function createProfileStore<T extends { name: string }>(
  dir: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodType<T, z.ZodTypeDef, any>
): ProfileStore<T> {
  async function ensureDir(): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  function getPath(name: string): string {
    return path.join(dir, `${name}.json`);
  }

  return {
    async list(): Promise<T[]> {
      await ensureDir();

      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw error;
      }

      const profiles: T[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await fs.readFile(path.join(dir, file), 'utf-8');
          const profile = schema.parse(JSON.parse(content));
          profiles.push(profile);
        } catch (error) {
          process.stderr.write(
            `Warning: Failed to load profile ${file}: ${error instanceof Error ? error.message : String(error)}\n`
          );
        }
      }

      return profiles.sort((a, b) => a.name.localeCompare(b.name));
    },

    async get(name: string): Promise<T | null> {
      try {
        const content = await fs.readFile(getPath(name), 'utf-8');
        return schema.parse(JSON.parse(content));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },

    async save(profile: T): Promise<void> {
      await ensureDir();
      await fs.writeFile(getPath(profile.name), JSON.stringify(profile, null, 2), { mode: 0o600 });
    },

    async delete(name: string): Promise<void> {
      try {
        await fs.unlink(getPath(name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }
    },
  };
}
