import { jest } from '@jest/globals';

export const getPassword = jest.fn<(service: string, account: string) => Promise<string | null>>();
export const setPassword =
  jest.fn<(service: string, account: string, password: string) => Promise<void>>();
export const deletePassword = jest.fn<(service: string, account: string) => Promise<boolean>>();
