import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

// Override HOME before importing the module so os.homedir() returns our temp dir
let tmpDir: string;
const originalHome = process.env.HOME;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agent-specs-test-'));
  process.env.HOME = tmpDir;
});

afterAll(async () => {
  process.env.HOME = originalHome;
  await rm(tmpDir, { recursive: true, force: true });
});

// Import after HOME is set
const { listAgentSpecs, getAgentSpec, saveAgentSpec, deleteAgentSpec, loadAgentSpecFile } =
  await import('./agent-specs.js');

describe('agent-specs', () => {
  const validSpec = {
    name: 'test-agent',
    workstationType: 'general-purpose',
  };

  afterEach(async () => {
    // Clean up specs between tests
    const specs = await listAgentSpecs();
    for (const spec of specs) {
      await deleteAgentSpec(spec.name);
    }
  });

  it('listAgentSpecs returns empty array when no specs exist', async () => {
    const specs = await listAgentSpecs();
    expect(specs).toEqual([]);
  });

  it('saveAgentSpec + getAgentSpec round-trip', async () => {
    await saveAgentSpec(validSpec);
    const spec = await getAgentSpec('test-agent');
    expect(spec).toEqual(validSpec);
  });

  it('listAgentSpecs returns saved specs sorted by name', async () => {
    await saveAgentSpec({ name: 'charlie-bot', workstationType: 'general-purpose' });
    await saveAgentSpec({ name: 'alpha-bot', workstationType: 'general-purpose' });
    await saveAgentSpec({ name: 'bravo-bot', workstationType: 'general-purpose' });
    const specs = await listAgentSpecs();
    expect(specs.map((s) => s.name)).toEqual(['alpha-bot', 'bravo-bot', 'charlie-bot']);
  });

  it('deleteAgentSpec removes a spec', async () => {
    await saveAgentSpec(validSpec);
    expect(await getAgentSpec('test-agent')).not.toBeNull();
    await deleteAgentSpec('test-agent');
    expect(await getAgentSpec('test-agent')).toBeNull();
  });

  it('getAgentSpec returns null for non-existent spec', async () => {
    const spec = await getAgentSpec('nonexistent');
    expect(spec).toBeNull();
  });

  it('deleteAgentSpec is a no-op for non-existent spec', async () => {
    await expect(deleteAgentSpec('nonexistent')).resolves.toBeUndefined();
  });

  it('saves and loads spec with instructions', async () => {
    const specWithInstructions = {
      name: 'support-bot',
      workstationType: 'customer-service',
      keyProfile: 'prod-keys',
      instructions: {
        purpose: 'Handle support tickets',
        repos: [{ url: 'org/support-tools' }],
        cron: [],
      },
    };
    await saveAgentSpec(specWithInstructions);
    const loaded = await getAgentSpec('support-bot');
    expect(loaded?.instructions?.purpose).toBe('Handle support tickets');
    expect(loaded?.instructions?.repos).toHaveLength(1);
  });

  it('loadAgentSpecFile loads from arbitrary path', async () => {
    const specPath = path.join(tmpDir, 'my-spec.yaml');
    await writeFile(
      specPath,
      YAML.stringify({ name: 'file-spec', workstationType: 'general-purpose' })
    );
    const spec = await loadAgentSpecFile(specPath);
    expect(spec.name).toBe('file-spec');
    expect(spec.workstationType).toBe('general-purpose');
  });

  it('loadAgentSpecFile throws on invalid spec', async () => {
    const specPath = path.join(tmpDir, 'bad-spec.yaml');
    await writeFile(specPath, YAML.stringify({ name: 'BadName!' }));
    await expect(loadAgentSpecFile(specPath)).rejects.toThrow();
  });

  it('loadAgentSpecFile throws on missing file', async () => {
    await expect(loadAgentSpecFile('/nonexistent/path.yaml')).rejects.toThrow();
  });
});
