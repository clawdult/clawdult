import { jest } from '@jest/globals';
import { retryWithBackoff } from './aws-retry.js';

describe('retryWithBackoff', () => {
  it('returns result on first success', async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors', async () => {
    const error = new Error('throttled');
    error.name = 'ThrottlingException';
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-transient errors', async () => {
    const error = new Error('bad request');
    error.name = 'ValidationException';
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(error);
    await expect(retryWithBackoff(fn, { baseDelayMs: 1 })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after max retries', async () => {
    const error = new Error('throttled');
    error.name = 'ThrottlingException';
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(error);
    await expect(retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow(
      'throttled'
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects custom transient error list', async () => {
    const error = new Error('custom error');
    error.name = 'CustomTransient';
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, {
      baseDelayMs: 1,
      transientErrors: ['CustomTransient'],
    });
    expect(result).toBe('ok');
  });

  it('retries on NoSuchEntityException by default', async () => {
    const error = new Error('entity not found');
    error.name = 'NoSuchEntityException';
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('found');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('found');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
