import type { ResolvedArtifact, VendorPlatform } from './types.js';

/** 支持 applyMirror 改写的 vendor（与 mirror-presets 对齐） */
export const MIRROR_REWRITE_VENDORS = new Set(['temurin', 'golang', 'flutter', 'nodejs', 'maven', 'miniconda']);

/**
 * mirror 仅替换 tarball 下载 URL（metadata 始终走官方 API）。按 vendor 分派策略：
 * - temurin：官方 GitHub URL → 镜像结构 {root}/{major}/jdk/{arch}/{os}/{file}（已验证镜像：https://mirrors.nju.edu.cn/adoptium）
 * - golang：文件名直接拼接 {root}/{filename}（兼容 https://golang.google.cn/dl 与 https://mirrors.aliyun.com/golang）
 * - flutter：官方桶前缀替换 storage.googleapis.com/flutter_infra_release → {root}（已验证镜像：https://mirror.nju.edu.cn/flutter/flutter_infra_release）
 * - nodejs：官方分发根前缀替换 nodejs.org/dist → {root}（已验证镜像：https://mirror.nju.edu.cn/nodejs-release）
 * - maven：官方仓库根前缀替换 repo.maven.apache.org/maven2 → {root}（已验证：阿里云 central、华为云 maven）
 * - miniconda：官方安装器目录前缀替换 repo.anaconda.com/miniconda → {root}（只换 sdkvm 下载 Miniconda 的地址）
 */
export function applyMirror(
  artifact: ResolvedArtifact,
  platform: VendorPlatform,
  mirrorRoot: string | null | undefined,
): ResolvedArtifact {
  return applyMirrorDetail(artifact, platform, mirrorRoot).artifact;
}

export function applyMirrorDetail(
  artifact: ResolvedArtifact,
  platform: VendorPlatform,
  mirrorRoot: string | null | undefined,
): { artifact: ResolvedArtifact; applied: boolean } {
  if (!mirrorRoot?.trim()) return { artifact, applied: false };
  const root = mirrorRoot.trim().replace(/\/+$/, '');
  if (artifact.vendorId === 'golang') {
    const file = artifact.downloadUrl.split('/').pop();
    if (!file) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: `${root}/${file}` }, applied: true };
  }
  if (artifact.vendorId === 'flutter') {
    const url = artifact.downloadUrl.replace(
      /^https:\/\/storage\.googleapis\.com\/flutter_infra_release/,
      root,
    );
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId === 'nodejs') {
    const url = artifact.downloadUrl.replace(/^https:\/\/nodejs\.org\/dist/, root);
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId === 'maven') {
    const url = artifact.downloadUrl.replace(/^https:\/\/repo\.maven\.apache\.org\/maven2/, root);
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId === 'miniconda') {
    const url = artifact.downloadUrl.replace(/^https:\/\/repo\.anaconda\.com\/miniconda/, root);
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId !== 'temurin') return { artifact, applied: false };
  const m =
    /^https:\/\/github\.com\/adoptium\/temurin(\d+)-binaries\/releases\/download\/[^/]+\/(.+)$/.exec(
      artifact.downloadUrl,
    );
  if (!m || !m[1] || !m[2]) return { artifact, applied: false };
  const url = `${root}/${m[1]}/jdk/${platform.arch}/${platform.os}/${m[2]}`;
  return { artifact: { ...artifact, downloadUrl: url }, applied: true };
}

/**
 * 校验文件紧挨归档（Maven `.sha512`、Temurin `.json`、Corretto `.sha256`）时，
 * 官方 URL 不可达可以改拉镜像归档旁边的同一旁路文件。
 */
export function checksumSidecarFallback(
  officialDownload: string,
  officialChecksum: string | undefined,
  mirroredDownload: string,
): string | undefined {
  if (!officialChecksum || mirroredDownload === officialDownload) return undefined;
  if (!officialChecksum.startsWith(officialDownload)) return undefined;
  const suffix = officialChecksum.slice(officialDownload.length);
  if (!/^\.[A-Za-z0-9.]+$/.test(suffix)) return undefined;
  return mirroredDownload + suffix;
}
