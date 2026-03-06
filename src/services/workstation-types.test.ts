import { listWorkstationTypes, getWorkstationType, BUILTIN_TYPES } from './workstation-types.js';

describe('workstation-types', () => {
  it('lists all built-in types', () => {
    const types = listWorkstationTypes();
    expect(types.length).toBe(3);

    const names = types.map((t) => t.name);
    expect(names).toContain('general-purpose');
    expect(names).toContain('data-science');
    expect(names).toContain('customer-service');
  });

  it('gets a type by name', () => {
    const ds = getWorkstationType('data-science');
    expect(ds).toBeDefined();
    expect(ds!.name).toBe('data-science');
    expect(ds!.capabilities).toContain('sagemaker');
  });

  it('returns undefined for unknown type', () => {
    expect(getWorkstationType('nonexistent')).toBeUndefined();
  });

  it('general-purpose has no capabilities', () => {
    const gp = getWorkstationType('general-purpose');
    expect(gp!.capabilities).toEqual([]);
  });

  it('customer-service has minimal tools', () => {
    const cs = getWorkstationType('customer-service');
    expect(cs!.tools.codex).toBe(false);
    expect(cs!.tools.docker).toBe(false);
    expect(cs!.tools.claudeCode).toBe(true);
    expect(cs!.tools.playwright).toBe(true);
  });

  it('BUILTIN_TYPES is the same reference as listWorkstationTypes', () => {
    expect(listWorkstationTypes()).toBe(BUILTIN_TYPES);
  });
});
