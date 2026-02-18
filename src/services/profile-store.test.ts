import { jest } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createProfileStore } from './profile-store.js';

const TestProfileSchema = z.object({
  name: z.string(),
  value: z.number(),
});
type TestProfile = z.infer<typeof TestProfileSchema>;

describe('createProfileStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'profile-store-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('list() returns empty array for empty dir', async () => {
    const store = createProfileStore<TestProfile>(tmpDir, TestProfileSchema);
    const profiles = await store.list();
    expect(profiles).toEqual([]);
  });

  it('save() + get() round-trip', async () => {
    const store = createProfileStore<TestProfile>(tmpDir, TestProfileSchema);
    await store.save({ name: 'alpha', value: 42 });
    const profile = await store.get('alpha');
    expect(profile).toEqual({ name: 'alpha', value: 42 });
  });

  it('list() returns saved profiles sorted by name', async () => {
    const store = createProfileStore<TestProfile>(tmpDir, TestProfileSchema);
    await store.save({ name: 'charlie', value: 3 });
    await store.save({ name: 'alpha', value: 1 });
    await store.save({ name: 'bravo', value: 2 });
    const profiles = await store.list();
    expect(profiles.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('delete() removes a profile', async () => {
    const store = createProfileStore<TestProfile>(tmpDir, TestProfileSchema);
    await store.save({ name: 'todelete', value: 99 });
    expect(await store.get('todelete')).not.toBeNull();
    await store.delete('todelete');
    expect(await store.get('todelete')).toBeNull();
  });

  it('get() returns null for non-existent profile', async () => {
    const store = createProfileStore<TestProfile>(tmpDir, TestProfileSchema);
    const profile = await store.get('nonexistent');
    expect(profile).toBeNull();
  });

  it('delete() is a no-op for non-existent profile', async () => {
    const store = createProfileStore<TestProfile>(tmpDir, TestProfileSchema);
    await expect(store.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('list() warns on invalid JSON files but does not throw', async () => {
    const store = createProfileStore<TestProfile>(tmpDir, TestProfileSchema);
    // Write a valid profile
    await store.save({ name: 'good', value: 1 });
    // Write an invalid JSON file directly
    await writeFile(path.join(tmpDir, 'bad.json'), 'not valid json');
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const profiles = await store.list();
    expect(profiles).toEqual([{ name: 'good', value: 1 }]);
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('list() skips non-JSON files', async () => {
    const store = createProfileStore<TestProfile>(tmpDir, TestProfileSchema);
    await store.save({ name: 'valid', value: 1 });
    await writeFile(path.join(tmpDir, 'readme.txt'), 'not a profile');
    const profiles = await store.list();
    expect(profiles).toEqual([{ name: 'valid', value: 1 }]);
  });

  it('save() creates directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'deep');
    const store = createProfileStore<TestProfile>(nestedDir, TestProfileSchema);
    await store.save({ name: 'nested', value: 7 });
    const profile = await store.get('nested');
    expect(profile).toEqual({ name: 'nested', value: 7 });
  });
});
