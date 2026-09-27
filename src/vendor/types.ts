import type { SdkTypeId } from '../sdk/types.js';
import type { SdkVersion, UserSpec, VersionSpec } from '../core/version.js';

/** vendor 层需要的平台信息（core/platform.ts 的 Platform 结构兼容） */
export interface VendorPlatform {
  os: 'mac' | 'linux' | 'windows';
  arch: 'aarch64' | 'x64';
}

/** 版本线：java 一个 major 一条线（key "21"），go / flutter / maven / python 一条 minor 线（key "1.24" / "3.47" / "3.9" / "3.12"） */
export interface ReleaseLine {
  key: string;
  lts: boolean;
  /** 该线最新完整版本（corretto 等无列表 API 的 vendor 可缺省） */
  latestFullVersion?: string;
}

export interface ResolvedArtifact {
  vendorId: string;
  version: SdkVersion;
  /** 落盘目录名，如 "temurin-21.0.5+11" */
  dirName: string;
  /** 展示名，如 "Temurin 21.0.5+11" */
  displayName: string;
  downloadUrl: string;
  /**
   * 校验信息；尽力校验，缺失时 warn 放行。
   * sha256：Go / Flutter / Node / Java。sha512：较新的 Maven Central 旁路；更早的 Maven 只有 .sha1。
   */
  checksum: { kind: 'sha256' | 'sha512'; url?: string; expected?: string } | null;
  /** sh / exe 是 Miniconda 静默安装器，不走 tar/zip 解压 */
  archive: 'tar.gz' | 'tar.xz' | 'zip' | 'sh' | 'exe';
}

export interface Vendor {
  readonly id: string;
  readonly label: string;
  readonly sdk: SdkTypeId;
  /** false = 无版本列表 API，仅支持按 major 安装最新（corretto） */
  readonly supportsFullVersionList: boolean;
  listMajors(): Promise<ReleaseLine[]>;
  resolve(spec: VersionSpec, platform: VendorPlatform): Promise<ResolvedArtifact>;
}

export type { SdkVersion, UserSpec, VersionSpec };
