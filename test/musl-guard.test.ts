import { describe, expect, it, vi } from 'vitest';
import { cpythonVendor } from '../src/vendor/python.js';
import { minicondaVendor } from '../src/vendor/miniconda.js';
import { nodejsVendor } from '../src/vendor/nodejs.js';
import { correttoVendor } from '../src/vendor/corretto.js';
import { flutterVendor } from '../src/vendor/flutter.js';
import { temurinVendor } from '../src/vendor/temurin.js';

// 文件级 mock：hostLibc 恒报 musl（模拟 Alpine 等 musl 主机），其余 platform 行为原样。
// Python / Miniconda / Flutter / Node aarch64 没有官方 musl 包，必须在联网前拒绝。
// Corretto 与 Temurin 有官方 alpine 构建，musl 主机应解析到那条 URL，而不是 glibc 包。
vi.mock('../src/core/platform.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/platform.js')>();
  return { ...orig, hostLibc: () => 'musl' as const };
});

const LINUX_X64 = { os: 'linux' as const, arch: 'x64' as const };

describe('musl 主机守卫（glibc-only 基线在解析期拒绝）', () => {
  it('python: resolve throws a musl error with an alternative hint', async () => {
    await expect(cpythonVendor.resolve({ kind: 'latest' }, LINUX_X64)).rejects.toThrow(/musl/i);
  });

  it('miniconda: resolve throws a musl error', async () => {
    await expect(minicondaVendor.resolve({ kind: 'latest' }, LINUX_X64)).rejects.toThrow(/musl/i);
  });

  it('nodejs: aarch64 musl resolve throws (官方无 arm64 musl 构建)；x64 走官方 musl 归档', async () => {
    // x64 不再前置拒绝：官方自 v24.21.0 起提供 linux-x64-musl（行为测试在 nodejs.test.ts）
    await expect(nodejsVendor.resolve({ kind: 'latest' }, { os: 'linux', arch: 'aarch64' })).rejects.toThrow(
      /musl/i,
    );
  });

  it('flutter rejects musl before any network call', async () => {
    await expect(flutterVendor.resolve({ kind: 'latest' }, LINUX_X64)).rejects.toThrow(/musl/i);
  });

  it('corretto on musl resolves the official alpine tarball, not the glibc one', async () => {
    const location =
      'https://corretto.aws/downloads/resources/21.0.12.12.1/amazon-corretto-21.0.12.12.1-alpine-linux-x64.tar.gz';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/latest_sha256/')) {
          expect(u).toContain('/amazon-corretto-21-x64-alpine-jdk.tar.gz');
          return new Response('ab'.repeat(32));
        }
        if (u.includes('/latest/')) {
          expect(u).toContain('/amazon-corretto-21-x64-alpine-jdk.tar.gz');
          return new Response(null, { status: 302, headers: { location } });
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
    const major = await correttoVendor.resolve({ kind: 'major', major: 21 }, LINUX_X64);
    expect(major.downloadUrl).toBe(location);
    expect(major.checksum?.expected).toBe('ab'.repeat(32));

    const exact = await correttoVendor.resolve({ kind: 'full', version: '21.0.8.9.1' }, LINUX_X64);
    expect(exact.downloadUrl).toBe(
      'https://corretto.aws/downloads/resources/21.0.8.9.1/amazon-corretto-21.0.8.9.1-alpine-linux-x64.tar.gz',
    );
  });

  it('temurin major on musl asks Adoptium for alpine-linux', async () => {
    const link =
      'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_alpine-linux_hotspot_21.0.5_11.tar.gz';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(String(url)).toContain('os=alpine-linux');
        return new Response(JSON.stringify([{ binary: { package: { link, checksum: 'a'.repeat(64) } } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const a = await temurinVendor.resolve({ kind: 'major', major: 21 }, LINUX_X64);
    expect(a.downloadUrl).toBe(link);
  });

  it('guards do not fire for non-linux platforms', async () => {
    // mac 上的 hostLibc 结果不应影响非 linux 平台：mock 恒 musl 也放行
    // （走不到网络才算守卫位置正确——用 lts 这种纯前置拒绝验证入口未被拦截）
    const MAC = { os: 'mac' as const, arch: 'aarch64' as const };
    await expect(cpythonVendor.resolve({ kind: 'lts' }, MAC)).rejects.toThrow(/lts/);
  });
});
