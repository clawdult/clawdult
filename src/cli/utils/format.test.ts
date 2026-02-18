import { jest } from '@jest/globals';
import { formatState, formatDuration } from './format.js';

// Strip ANSI codes for easier testing
// eslint-disable-next-line no-control-regex
const stripAnsi = (str: string) => str.replace(/\x1B\[[0-9;]*m/g, '');

describe('formatState', () => {
  it('formats running state with indicator', () => {
    const result = stripAnsi(formatState('running'));
    expect(result).toBe('● running');
  });

  it('formats pending state with indicator', () => {
    const result = stripAnsi(formatState('pending'));
    expect(result).toBe('○ pending');
  });

  it('formats stopping state with indicator', () => {
    const result = stripAnsi(formatState('stopping'));
    expect(result).toBe('◐ stopping');
  });

  it('formats stopped state with indicator', () => {
    const result = stripAnsi(formatState('stopped'));
    expect(result).toBe('○ stopped');
  });

  it('formats shutting-down state with indicator', () => {
    const result = stripAnsi(formatState('shutting-down'));
    expect(result).toBe('◐ shutting-down');
  });

  it('formats terminated state with indicator', () => {
    const result = stripAnsi(formatState('terminated'));
    expect(result).toBe('✕ terminated');
  });

  it('handles all valid instance states', () => {
    const states = [
      'pending',
      'running',
      'shutting-down',
      'terminated',
      'stopping',
      'stopped',
    ] as const;
    for (const state of states) {
      expect(() => formatState(state)).not.toThrow();
      const result = formatState(state);
      expect(result).toBeTruthy();
    }
  });
});

describe('formatDuration', () => {
  beforeEach(() => {
    // Use Jest fake timers to control Date
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns dash for undefined launch time', () => {
    expect(formatDuration(undefined)).toBe('-');
  });

  it('formats minutes for recent launches', () => {
    const launchTime = new Date('2024-06-15T11:45:00Z'); // 15 minutes ago
    expect(formatDuration(launchTime)).toBe('15m');
  });

  it('formats hours for same-day launches', () => {
    const launchTime = new Date('2024-06-15T09:00:00Z'); // 3 hours ago
    expect(formatDuration(launchTime)).toBe('3h');
  });

  it('formats days and hours for multi-day uptime', () => {
    const launchTime = new Date('2024-06-13T08:00:00Z'); // 2 days + 4 hours ago
    expect(formatDuration(launchTime)).toBe('2d 4h');
  });

  it('formats many days correctly', () => {
    const launchTime = new Date('2024-06-01T12:00:00Z'); // 14 days ago
    expect(formatDuration(launchTime)).toBe('14d 0h');
  });

  it('returns 0m for just-launched instances', () => {
    const launchTime = new Date('2024-06-15T12:00:00Z'); // exactly now
    expect(formatDuration(launchTime)).toBe('0m');
  });

  it('returns 0m for instances launched within the last minute', () => {
    const launchTime = new Date('2024-06-15T11:59:30Z'); // 30 seconds ago
    expect(formatDuration(launchTime)).toBe('0m');
  });
});
