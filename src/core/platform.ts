import fs from 'node:fs';
import { SdkvmError } from '../util/errors.js';

/** 三家 vendor 通用的平台描述 */
export interface Platform {
  os: 'mac' | 'linux' | 'windows';
  arch: 'aarch64' | 'x64';
  /** Node 原始值，供特殊分支使用 */
  rawPlatform: NodeJS.Platform;
  rawArch: string;
}

/**
 * 主机 libc 探测（仅 Linux 有意义）。非 Linux 返回 null。
 *
 * 不能只看 ld-musl 是否存在：Debian/Ubuntu 的 `musl`/`musl-tools` 包也会装 loader，
 * 主机仍是 glibc——误判会导致装错 alpine JDK、或拒绝本可安装的 Python/Miniconda。
 * 判定顺序：Alpine 发行标记 → 默认动态链接器（glibc 的 ld-linux*）→ musl loader → 默认 glibc。
 */
export function hostLibc(arch: 'aarch64' | 'x64' = process.arch === 'arm64' ? 'aarch64' : 'x64'): 'glibc' | 'musl' | null {
  if (process.platform !== 'linux') return null;
  if (fs.existsSync('/etc/alpine-release')) return 'musl';
  const gnuLoaders =
    arch === 'aarch64'
      ? ['/lib/ld-linux-aarch64.so.1', '/lib64/ld-linux-aarch64.so.1']
      : [
          '/lib64/ld-linux-x86-64.so.2',
          '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
          '/lib/ld-linux-x86-64.so.2',
        ];
  if (gnuLoaders.some((p) => fs.existsSync(p))) return 'glibc';
  const name = arch === 'aarch64' ? 'aarch64' : 'x86_64';
  const muslLoaders = [`/lib/ld-musl-${name}.so.1`, `/usr/lib/ld-musl-${name}.so.1`];
  if (muslLoaders.some((p) => fs.existsSync(p))) return 'musl';
  return 'glibc';
}

export function detectPlatform(override?: { platform?: string; arch?: string }): Platform {
  const rawPlatform = (override?.platform ?? process.platform) as NodeJS.Platform;
  const rawArch = override?.arch ?? process.arch;

  const osMap: Record<string, Platform['os']> = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'windows',
  };
  const archMap: Record<string, Platform['arch']> = {
    arm64: 'aarch64',
    aarch64: 'aarch64',
    x64: 'x64',
  };

  const os = osMap[rawPlatform];
  const arch = archMap[rawArch];
  if (!os) {
    throw new SdkvmError(`Unsupported operating system: ${rawPlatform}`, {
      hint: 'sdkvm currently supports macOS, Linux and Windows.',
    });
  }
  if (!arch) {
    throw new SdkvmError(`Unsupported CPU architecture: ${rawArch}`, {
      hint: 'sdkvm currently supports aarch64 (Apple Silicon / ARM) and x64.',
    });
  }
  return { os, arch, rawPlatform, rawArch };
}

export function isWindows(platform: Platform): boolean {
  return platform.os === 'windows';
}
