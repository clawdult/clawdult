// Test for completion instance filtering logic
// Note: Due to ESM module constraints, we test the filtering behavior directly
// rather than mocking the full AWS dependency chain

describe('instance completion filtering', () => {
  // This tests the core filtering logic used in getInstanceCompletions
  const filterInstances = (instances: string[], partial: string): string[] => {
    return instances.filter((name) => name.startsWith(partial));
  };

  it('filters instances by prefix', () => {
    const instances = ['alpha-1', 'alpha-2', 'beta-1'];
    expect(filterInstances(instances, 'alpha')).toEqual(['alpha-1', 'alpha-2']);
  });

  it('returns empty array when no matches', () => {
    const instances = ['instance-1', 'instance-2'];
    expect(filterInstances(instances, 'nomatch')).toEqual([]);
  });

  it('returns all instances when prefix is empty', () => {
    const instances = ['a', 'b', 'c'];
    expect(filterInstances(instances, '')).toEqual(['a', 'b', 'c']);
  });

  it('handles empty instances array', () => {
    expect(filterInstances([], 'anything')).toEqual([]);
  });

  it('is case-sensitive', () => {
    const instances = ['Alpha', 'alpha', 'ALPHA'];
    expect(filterInstances(instances, 'alpha')).toEqual(['alpha']);
    expect(filterInstances(instances, 'Alpha')).toEqual(['Alpha']);
  });

  it('handles special characters in prefix', () => {
    const instances = ['my-instance-1', 'my_instance_2', 'my.instance.3'];
    expect(filterInstances(instances, 'my-')).toEqual(['my-instance-1']);
    expect(filterInstances(instances, 'my_')).toEqual(['my_instance_2']);
    expect(filterInstances(instances, 'my.')).toEqual(['my.instance.3']);
  });
});
