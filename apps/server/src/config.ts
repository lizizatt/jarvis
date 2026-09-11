import { isAbsolute } from 'node:path';

export function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function nodeTimeout(value: string | undefined, fallback: number, name: string): number {
  const timeout = positiveInteger(value, fallback, name);
  if (timeout > 2_147_483_647) throw new Error(`${name} must be a positive integer no greater than 2147483647`);
  return timeout;
}

export function tcpPort(value: string | undefined, fallback: number, name: string): number {
  const port = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return port;
}

export function absolutePath(value: string | undefined, fallback: string, name: string): string {
  const path = value || fallback;
  if (!isAbsolute(path) || /[\n\r\0]/.test(path)) throw new Error(`${name} must be an absolute path`);
  return path;
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
