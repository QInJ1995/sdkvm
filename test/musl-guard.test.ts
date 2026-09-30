import { describe, expect, it, vi } from 'vitest';
import { cpythonVendor } from '../src/vendor/python.js';
import { minicondaVendor } from '../src/vendor/miniconda.js';
import { nodejsVendor } from '../src/vendor/nodejs.js';

// 文件级 mock：hostLibc 恒报 musl（模拟 Alpine 等 musl 主机），其余 platform 行为原样。
// 三个基线都是 glibc-only：守卫必须在任何网络请求之前于 resolve 入口拒绝，
// 否则装上后首次运行才报 loader 错。
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

  it('guards do not fire for non-linux platforms', async () => {
    // mac 上的 hostLibc 结果不应影响非 linux 平台：mock 恒 musl 也放行
    // （走不到网络才算守卫位置正确——用 lts 这种纯前置拒绝验证入口未被拦截）
    const MAC = { os: 'mac' as const, arch: 'aarch64' as const };
    await expect(cpythonVendor.resolve({ kind: 'lts' }, MAC)).rejects.toThrow(/lts/);
  });
});
