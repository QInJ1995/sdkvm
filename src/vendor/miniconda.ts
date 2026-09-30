import { httpText } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { cmdPath } from '../cli/cmdname.js';
import { detectPlatform, hostLibc } from '../core/platform.js';
import {
  compareVersions,
  formatMinicondaLine,
  formatMinicondaVersion,
  minicondaMatchesFull,
  parseMinicondaVersion,
  type SdkVersion,
} from '../core/version.js';
import type { ReleaseLine, ResolvedArtifact, Vendor, VendorPlatform, VersionSpec } from './types.js';
import { groupMinorLines, specLabel } from './shared.js';

/** Miniconda 安装器目录。版本清单与 SHA256 始终走这里；镜像只改安装器 URL。 */
export const MINICONDA_ARCHIVE = 'https://repo.anaconda.com/miniconda';

export interface MinicondaFile {
  filename: string;
  version: SdkVersion;
  sha256: string;
  os: 'MacOSX' | 'Linux' | 'Windows';
  arch: 'arm64' | 'x86_64' | 'aarch64';
  ext: 'sh' | 'exe';
}

const FILE_RE =
  /^Miniconda3-(?:py(\d)(\d+)_)?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?-(MacOSX|Linux|Windows)-(arm64|x86_64|aarch64)\.(sh|exe)$/;

/** 从官方目录页抽出 Miniconda3 安装器。忽略 latest 别名、.pkg 和四段旧版本号。 */
export function parseMinicondaIndex(html: string): MinicondaFile[] {
  const out: MinicondaFile[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const body = row[1] ?? '';
    const href = /href="(Miniconda3-[^"]+)"/.exec(body);
    const sha = />([0-9a-f]{64})</i.exec(body);
    if (!href?.[1] || !sha?.[1]) continue;
    const parsed = FILE_RE.exec(href[1]);
    if (!parsed || !parsed[3] || !parsed[4] || !parsed[5] || !parsed[7] || !parsed[8] || !parsed[9]) continue;
    const token = href[1].slice('Miniconda3-'.length).replace(/-(MacOSX|Linux|Windows)-.*$/, '');
    let version: SdkVersion;
    try {
      version = parseMinicondaVersion('miniconda', token);
    } catch {
      continue;
    }
    out.push({
      filename: href[1],
      version,
      sha256: sha[1].toLowerCase(),
      os: parsed[7] as MinicondaFile['os'],
      arch: parsed[8] as MinicondaFile['arch'],
      ext: parsed[9] as MinicondaFile['ext'],
    });
  }
  return out;
}

function matchesPlatform(file: MinicondaFile, platform: VendorPlatform): boolean {
  if (platform.os === 'mac') {
    const arch = platform.arch === 'aarch64' ? 'arm64' : 'x86_64';
    return file.os === 'MacOSX' && file.arch === arch && file.ext === 'sh';
  }
  if (platform.os === 'linux') {
    const arch = platform.arch === 'aarch64' ? 'aarch64' : 'x86_64';
    return file.os === 'Linux' && file.arch === arch && file.ext === 'sh';
  }
  return platform.arch === 'x64' && file.os === 'Windows' && file.arch === 'x86_64' && file.ext === 'exe';
}

function assertSupportedPlatform(platform: VendorPlatform): void {
  if (platform.os === 'windows' && platform.arch !== 'x64') {
    throw new SdkvmError(`No Miniconda installer for ${platform.os}/${platform.arch}`, {
      hint: 'Miniconda publishes Windows x64 installers only.',
    });
  }
}

function uniqueDesc(files: MinicondaFile[]): SdkVersion[] {
  const map = new Map<string, SdkVersion>();
  for (const file of files) {
    const key = formatMinicondaVersion(file.version);
    if (!map.has(key)) map.set(key, file.version);
  }
  return [...map.values()].sort((a, b) => compareVersions(b, a));
}

function pick(versions: SdkVersion[], spec: VersionSpec): SdkVersion | undefined {
  if (spec.kind === 'latest') return versions[0];
  if (spec.kind === 'major') return versions.find((v) => v.major === spec.major);
  if (spec.kind === 'line') return versions.find((v) => v.major === spec.major && v.minor === spec.minor);
  if (spec.kind === 'full') return versions.find((v) => minicondaMatchesFull(v, spec.version));
  return undefined;
}

/** 当前平台实际有安装器的 minor 线。Intel Mac 没有 26.7 时不会把别的架构的最新版列出来。 */
export function minicondaReleaseLines(files: MinicondaFile[], platform: VendorPlatform): ReleaseLine[] {
  const versions = uniqueDesc(files.filter((file) => matchesPlatform(file, platform)));
  return groupMinorLines(versions, formatMinicondaLine, compareVersions, formatMinicondaVersion);
}

function buildArtifact(file: MinicondaFile): ResolvedArtifact {
  const display = formatMinicondaVersion(file.version);
  return {
    vendorId: 'miniconda',
    version: file.version,
    dirName: `miniconda-${display}`,
    displayName: `Miniconda ${display}`,
    downloadUrl: `${MINICONDA_ARCHIVE}/${file.filename}`,
    checksum: { kind: 'sha256', expected: file.sha256 },
    archive: file.ext,
  };
}

async function fetchIndex(): Promise<MinicondaFile[]> {
  const files = parseMinicondaIndex(await httpText(`${MINICONDA_ARCHIVE}/`));
  // 页面结构变化时明确报错，而不是让 ls -r / resolve 静默变成空列表
  if (files.length === 0) {
    throw new SdkvmError('Miniconda index format unrecognized', {
      hint: `${MINICONDA_ARCHIVE}/ listed no Miniconda3 installer rows`,
    });
  }
  return files;
}

export const minicondaVendor: Vendor = {
  id: 'miniconda',
  label: 'Miniconda',
  sdk: 'miniconda',
  supportsFullVersionList: true,

  async listMajors(): Promise<ReleaseLine[]> {
    const platform = detectPlatform();
    assertSupportedPlatform(platform);
    return minicondaReleaseLines(await fetchIndex(), platform);
  },

  async resolve(spec: VersionSpec, platform: VendorPlatform): Promise<ResolvedArtifact> {
    assertSupportedPlatform(platform);
    if (spec.kind === 'lts') {
      throw new SdkvmError('Unsupported version spec for Miniconda: lts', {
        hint: 'Miniconda has no lts alias — use "26", "26.7", "26.7.1-1", "py313", or "latest"',
      });
    }
    // 安装器脚本与内嵌二进制都是 glibc 链接：musl 主机上安装器自身就跑不起来，
    // 在解析阶段就拒绝，别让用户白下载 150MB
    if (platform.os === 'linux' && hostLibc(platform.arch) === 'musl') {
      throw new SdkvmError('Miniconda installers are glibc builds; musl Linux (Alpine) is not supported', {
        hint: 'conda does not publish musl installers; use micromamba or the distro python package',
      });
    }
    const files = await fetchIndex();
    const all = uniqueDesc(files);
    const forPlatform = uniqueDesc(files.filter((file) => matchesPlatform(file, platform)));
    const target = pick(forPlatform, spec);
    if (!target) {
      const existsElsewhere = pick(all, spec);
      if (existsElsewhere) {
        throw new SdkvmError(
          `No Miniconda ${formatMinicondaVersion(existsElsewhere)} installer for ${platform.os}/${platform.arch}`,
          { hint: `Run \`${cmdPath('miniconda')} ls -r\` and pick a release that ships this platform.` },
        );
      }
      throw new SdkvmError(`No Miniconda release matches "${specLabel(spec)}"`, {
        hint: `Run \`${cmdPath('miniconda')} ls -r\` to see available versions.`,
      });
    }
    const file = files.find(
      (item) => matchesPlatform(item, platform) && compareVersions(item.version, target) === 0,
    );
    if (!file) {
      throw new SdkvmError(
        `No Miniconda ${formatMinicondaVersion(target)} installer for ${platform.os}/${platform.arch}`,
        { hint: `Run \`${cmdPath('miniconda')} ls -r\` and pick a release that ships this platform.` },
      );
    }
    return buildArtifact(file);
  },
};
