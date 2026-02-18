import { jest } from '@jest/globals';

// Mock the aws-client module to prevent actual AWS calls during import
jest.unstable_mockModule('./aws-client.js', () => ({
  getAWSClientConfig: jest
    .fn<() => Promise<{ region: string }>>()
    .mockResolvedValue({ region: 'us-east-1' }),
}));

const { getCallerPublicIp } = await import('./ec2.js');

describe('getCallerPublicIp', () => {
  let fetchSpy: jest.SpiedFunction<typeof global.fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns IP from first endpoint on success', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('1.2.3.4\n', { status: 200 }));
    const ip = await getCallerPublicIp();
    expect(ip).toBe('1.2.3.4');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://checkip.amazonaws.com',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('falls back to second endpoint when first fails', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(new Response('5.6.7.8\n', { status: 200 }));
    const ip = await getCallerPublicIp();
    expect(ip).toBe('5.6.7.8');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back when first endpoint returns non-ok status', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('9.10.11.12', { status: 200 }));
    const ip = await getCallerPublicIp();
    expect(ip).toBe('9.10.11.12');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws when both endpoints fail', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('fail 1')).mockRejectedValueOnce(new Error('fail 2'));
    await expect(getCallerPublicIp()).rejects.toThrow(
      'Failed to determine public IP: all endpoints unreachable'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
