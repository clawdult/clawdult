import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Override HOME before importing the module so os.homedir() returns our temp dir
let tmpDir: string;
const originalHome = process.env.HOME;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ws-types-test-'));
  process.env.HOME = tmpDir;
});

afterAll(async () => {
  process.env.HOME = originalHome;
  await rm(tmpDir, { recursive: true, force: true });
});

const {
  listWorkstationTypes,
  getWorkstationType,
  isBuiltinType,
  saveCustomType,
  deleteCustomType,
  BUILTIN_TYPES,
} = await import('./workstation-types.js');

describe('workstation-types with custom types', () => {
  afterEach(async () => {
    // Clean up ALL custom type files (including overrides of builtins)
    const types = await listWorkstationTypes();
    for (const t of types) {
      // deleteCustomType only removes the JSON file; builtins still exist in code
      await deleteCustomType(t.name);
    }
  });

  it('listWorkstationTypes includes builtins when no custom types exist', async () => {
    const types = await listWorkstationTypes();
    expect(types.length).toBeGreaterThanOrEqual(3);
    const names = types.map((t) => t.name);
    expect(names).toContain('general-purpose');
    expect(names).toContain('data-science');
    expect(names).toContain('customer-service');
  });

  it('saveCustomType + getWorkstationType round-trip', async () => {
    await saveCustomType({
      name: 'my-custom',
      description: 'A custom type',
      capabilities: [],
      tools: {
        claudeCode: true,
        codex: false,
        grok: true,
        gemini: false,
        playwright: false,
        docker: false,
      },
    });
    const t = await getWorkstationType('my-custom');
    expect(t).toBeDefined();
    expect(t!.name).toBe('my-custom');
    expect(t!.tools.grok).toBe(true);
    expect(t!.tools.codex).toBe(false);
  });

  it('custom types appear in listWorkstationTypes', async () => {
    await saveCustomType({
      name: 'my-custom',
      description: 'Custom',
      capabilities: [],
      tools: {
        claudeCode: true,
        codex: true,
        grok: false,
        gemini: false,
        playwright: true,
        docker: true,
      },
    });
    const types = await listWorkstationTypes();
    const names = types.map((t) => t.name);
    expect(names).toContain('my-custom');
    expect(names).toContain('general-purpose');
  });

  it('custom type overrides builtin with same name', async () => {
    await saveCustomType({
      name: 'general-purpose',
      description: 'My overridden general purpose',
      capabilities: ['sagemaker'],
      tools: {
        claudeCode: true,
        codex: true,
        grok: true,
        gemini: true,
        playwright: true,
        docker: true,
      },
    });
    const t = await getWorkstationType('general-purpose');
    expect(t!.description).toBe('My overridden general purpose');
    expect(t!.capabilities).toContain('sagemaker');
    expect(t!.tools.grok).toBe(true);
  });

  it('listWorkstationTypes returns sorted results', async () => {
    await saveCustomType({
      name: 'zzz-last',
      description: 'Last',
      capabilities: [],
      tools: {
        claudeCode: true,
        codex: true,
        grok: false,
        gemini: false,
        playwright: true,
        docker: true,
      },
    });
    await saveCustomType({
      name: 'aaa-first',
      description: 'First',
      capabilities: [],
      tools: {
        claudeCode: true,
        codex: true,
        grok: false,
        gemini: false,
        playwright: true,
        docker: true,
      },
    });
    const types = await listWorkstationTypes();
    const names = types.map((t) => t.name);
    expect(names.indexOf('aaa-first')).toBeLessThan(names.indexOf('zzz-last'));
  });

  it('deleteCustomType removes custom type', async () => {
    await saveCustomType({
      name: 'temp-type',
      description: 'Temporary',
      capabilities: [],
      tools: {
        claudeCode: true,
        codex: true,
        grok: false,
        gemini: false,
        playwright: true,
        docker: true,
      },
    });
    expect(await getWorkstationType('temp-type')).toBeDefined();
    await deleteCustomType('temp-type');
    expect(await getWorkstationType('temp-type')).toBeUndefined();
  });

  it('isBuiltinType correctly identifies builtins', () => {
    expect(isBuiltinType('general-purpose')).toBe(true);
    expect(isBuiltinType('data-science')).toBe(true);
    expect(isBuiltinType('customer-service')).toBe(true);
    expect(isBuiltinType('my-custom')).toBe(false);
  });

  it('getWorkstationType falls back to builtin when no custom match', async () => {
    const t = await getWorkstationType('data-science');
    expect(t).toBeDefined();
    expect(t!.capabilities).toContain('sagemaker');
  });

  it('getWorkstationType returns undefined for unknown type', async () => {
    const t = await getWorkstationType('nonexistent-type');
    expect(t).toBeUndefined();
  });

  it('BUILTIN_TYPES has exactly 3 entries', () => {
    expect(BUILTIN_TYPES).toHaveLength(3);
  });
});
