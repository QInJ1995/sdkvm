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

/** 主机 libc 探测（仅 Linux 有意义）：musl 动态链接器存在即视为 musl（Alpine 等），
 *  否则 glibc；非 Linux 返回 null。nodejs.org / python.org 的官方归档都是 glibc 构建，
 *  vendor 在 musl 主机上要提前给出能读懂的错误，而不是装上后一跑就崩。 */
export function hostLibc(arch: 'aarch64' | 'x64' = process.arch === 'arm64' ? 'aarch64' : 'x64'): 'glibc' | 'musl' | null {
  if (process.platform !== 'linux') return null;
  const name = arch === 'aarch64' ? 'aarch64' : 'x86_64';
  const markers = [
    `/lib/ld-musl-${name}.so.1`,
    `/usr/lib/ld-musl-${name}.so.1`,
    // 加载器不在常规路径时（部分容器把 /lib 挪走），Alpine 发行标记仍能认出 musl
    '/etc/alpine-release',
  ];
  if (markers.some((m) => fs.existsSync(m))) return 'musl';
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
