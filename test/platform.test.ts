import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform, hostLibc } from '../src/core/platform.js';
import { SdkvmError } from '../src/util/errors.js';

describe('detectPlatform', () => {
  it('darwin arm64', () => {
    expect(detectPlatform({ platform: 'darwin', arch: 'arm64' })).toMatchObject({ os: 'mac', arch: 'aarch64' });
  });
  it('darwin x64', () => {
    expect(detectPlatform({ platform: 'darwin', arch: 'x64' })).toMatchObject({ os: 'mac', arch: 'x64' });
  });
  it('linux x64 / aarch64', () => {
    expect(detectPlatform({ platform: 'linux', arch: 'x64' }).os).toBe('linux');
    expect(detectPlatform({ platform: 'linux', arch: 'aarch64' }).os).toBe('linux');
  });
  it('win32 x64', () => {
    expect(detectPlatform({ platform: 'win32', arch: 'x64' })).toMatchObject({ os: 'windows', arch: 'x64' });
  });
  it('unsupported os/arch throw', () => {
    expect(() => detectPlatform({ platform: 'freebsd', arch: 'x64' })).toThrow(SdkvmError);
    expect(() => detectPlatform({ platform: 'linux', arch: 'arm' })).toThrow(SdkvmError);
  });
});

describe('hostLibc', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('non-linux returns null', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(hostLibc('x64')).toBeNull();
  });

  it('alpine-release → musl even if ld-linux also exists', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s === '/etc/alpine-release' || s.includes('ld-linux') || s.includes('ld-musl');
    });
    expect(hostLibc('x64')).toBe('musl');
  });

  it('glibc loader present → glibc even when musl loader package is installed', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      // 模拟 Debian 同时装了 musl-tools：两个 loader 都在，但默认是 glibc
      return s.includes('ld-linux') || s.includes('ld-musl');
    });
    expect(hostLibc('x64')).toBe('glibc');
  });

  it('only musl loader → musl', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).includes('ld-musl'));
    expect(hostLibc('x64')).toBe('musl');
  });
});
