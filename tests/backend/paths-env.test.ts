import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  const defaultPath = (actual as typeof actual & { default: typeof actual }).default;
  return {
    ...actual,
    default: { ...defaultPath, join: actual.win32.join },
  };
});

import { ensureUserBinPath } from '../../electron/core/linuxPath';

describe('ensureUserBinPath', () => {
  it.each(['linux', 'darwin'] as const)(
    'construye PATH POSIX en %s aunque el host use path.win32.join',
    (platform) => {
      const r = ensureUserBinPath(
        { PATH: '/usr/bin:/bin', HOME: '/home/u' },
        platform,
      );
      expect(r.added).toEqual(['/home/u/.local/bin', '/usr/local/bin']);
      expect(r.env.PATH).toBe(
        '/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin',
      );
      expect(ensureUserBinPath(r.env, platform).added).toEqual([]);
    },
  );
  it.each([
    ['/usr/bin:', '/home/u/.local/bin:/usr/local/bin:/usr/bin:'],
    [':/usr/bin::/bin', '/home/u/.local/bin:/usr/local/bin::/usr/bin::/bin'],
  ])('conserva componentes PATH vacíos en %s', (originalPath, expectedPath) => {
    const env = { PATH: originalPath, HOME: '/home/u' };
    const originalEnv = { ...env };

    const r = ensureUserBinPath(env, 'linux');

    expect(r.env.PATH).toBe(expectedPath);
    expect(env).toEqual(originalEnv);
    expect(env.PATH).toBe(originalPath);
  });
  it('sin PATH no añade un separador final', () => {
    const r = ensureUserBinPath({ HOME: '/home/u' }, 'linux');
    expect(r.env.PATH).toBe('/home/u/.local/bin:/usr/local/bin');
  });
  it('sin HOME añade solo /usr/local/bin', () => {
    const r = ensureUserBinPath({ PATH: '/usr/bin:/bin' }, 'linux');
    expect(r.added).toEqual(['/usr/local/bin']);
  });
  it('en win32 no toca nada', () => {
    const env = { PATH: 'C:\\x' };
    const r = ensureUserBinPath(env, 'win32');
    expect(r.added).toEqual([]);
    expect(r.env.PATH).toBe('C:\\x');
  });
});
