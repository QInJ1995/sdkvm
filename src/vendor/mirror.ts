import { hostLibc } from '../core/platform.js';
import type { ResolvedArtifact, VendorPlatform } from './types.js';

/** 字符串替换会把 `$&` / `$$` / `$'` 当模式。镜像根原样贴上。 */
function replacePrefix(url: string, pattern: RegExp, root: string): string {
  return url.replace(pattern, () => root);
}

/** 支持 applyMirror 改写的 vendor（与 mirror-presets 对齐） */
export const MIRROR_REWRITE_VENDORS = new Set([
  'temurin',
  'golang',
  'flutter',
  'nodejs',
  'maven',
  'miniconda',
  'cpython',
]);

/**
 * mirror 仅替换 tarball 下载 URL（metadata 始终走官方 API）。按 vendor 分派策略：
 * - temurin：官方 GitHub URL → 镜像结构 {root}/{major}/jdk/{arch}/{os}/{file}（已验证镜像：https://mirrors.nju.edu.cn/adoptium）
 * - golang：文件名直接拼接 {root}/{filename}（兼容 https://golang.google.cn/dl 与 https://mirrors.aliyun.com/golang）
 * - flutter：官方桶前缀替换 storage.googleapis.com/flutter_infra_release → {root}（已验证镜像：https://mirror.nju.edu.cn/flutter/flutter_infra_release）
 * - nodejs：官方分发根前缀替换 nodejs.org/dist → {root}（已验证镜像：https://mirror.nju.edu.cn/nodejs-release）
 * - maven：官方仓库根前缀替换 repo.maven.apache.org/maven2 → {root}（已验证：阿里云 central、华为云 maven）
 * - miniconda：官方安装器目录前缀替换 repo.anaconda.com/miniconda → {root}（只换 sdkvm 下载 Miniconda 的地址）
 * - cpython：GitHub download 前缀替换 github.com/astral-sh/python-build-standalone/releases/download → {root}，保留 /{tag}/{filename}
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
    const url = replacePrefix(artifact.downloadUrl, /^https:\/\/storage\.googleapis\.com\/flutter_infra_release/, root);
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId === 'nodejs') {
    const url = replacePrefix(artifact.downloadUrl, /^https:\/\/nodejs\.org\/dist/, root);
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId === 'maven') {
    const url = replacePrefix(artifact.downloadUrl, /^https:\/\/repo\.maven\.apache\.org\/maven2/, root);
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId === 'miniconda') {
    const url = replacePrefix(artifact.downloadUrl, /^https:\/\/repo\.anaconda\.com\/miniconda/, root);
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId === 'cpython') {
    const url = replacePrefix(
      artifact.downloadUrl,
      /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download/,
      root,
    );
    if (url === artifact.downloadUrl) return { artifact, applied: false };
    return { artifact: { ...artifact, downloadUrl: url }, applied: true };
  }
  if (artifact.vendorId !== 'temurin') return { artifact, applied: false };
  const m =
    /^https:\/\/github\.com\/adoptium\/temurin(\d+)-binaries\/releases\/download\/[^/]+\/(.+)$/.exec(
      artifact.downloadUrl,
    );
  if (!m || !m[1] || !m[2]) return { artifact, applied: false };
  const osToken = platform.os === 'linux' && hostLibc(platform.arch) === 'musl' ? 'alpine-linux' : platform.os;
  const url = `${root}/${m[1]}/jdk/${platform.arch}/${osToken}/${m[2]}`;
  return { artifact: { ...artifact, downloadUrl: url }, applied: true };
}
