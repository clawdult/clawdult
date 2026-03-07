import {
  listWorkstationTypes,
  getWorkstationType,
  BUILTIN_TYPES,
  isBuiltinType,
} from './workstation-types.js';

describe('workstation-types', () => {
  it('lists all built-in types', async () => {
    const types = await listWorkstationTypes();
    expect(types.length).toBeGreaterThanOrEqual(3);

    const names = types.map((t) => t.name);
    expect(names).toContain('general-purpose');
    expect(names).toContain('data-science');
    expect(names).toContain('customer-service');
  });

  it('gets a type by name', async () => {
    const ds = await getWorkstationType('data-science');
    expect(ds).toBeDefined();
    expect(ds!.name).toBe('data-science');
    expect(ds!.capabilities).toContain('sagemaker');
  });

  it('returns undefined for unknown type', async () => {
    expect(await getWorkstationType('nonexistent')).toBeUndefined();
  });

  it('general-purpose has no capabilities', async () => {
    const gp = await getWorkstationType('general-purpose');
    expect(gp!.capabilities).toEqual([]);
  });

  it('customer-service has minimal tools', async () => {
    const cs = await getWorkstationType('customer-service');
    expect(cs!.tools.codex).toBe(false);
    expect(cs!.tools.docker).toBe(false);
    expect(cs!.tools.claudeCode).toBe(true);
    expect(cs!.tools.playwright).toBe(true);
  });

  it('BUILTIN_TYPES contains all three built-in types', () => {
    expect(BUILTIN_TYPES.length).toBe(3);
  });

  it('isBuiltinType identifies builtins correctly', () => {
    expect(isBuiltinType('general-purpose')).toBe(true);
    expect(isBuiltinType('custom-thing')).toBe(false);
  });
});
