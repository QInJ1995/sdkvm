import type { ReleaseLine, ResolvedArtifact, Vendor, VendorPlatform, VersionSpec } from './types.js';
import { httpJson } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { compareVersions, formatGoVersion, parseGoVersion, type SdkVersion } from '../core/version.js';
import { cmdPath } from '../cli/cmdname.js';
import { groupMinorLines, specLabel } from './shared.js';

const LIST_URL = 'https://go.dev/dl/?mode=json&include=all';

interface GoFile {
  filename: string;
  os: string;
  arch: string;
  kind: string;
  sha256: string;
  size: number;
}

interface GoRelease {
  version: string;
  stable: boolean;
  files: GoFile[];
}

/** 平台命名差异：os mac→darwin；arch x64→amd64、aarch64→arm64 */
const GO_OS = { mac: 'darwin', linux: 'linux', windows: 'windows' } as const;
const GO_ARCH = { aarch64: 'arm64', x64: 'amd64' } as const;

async function fetchReleases(): Promise<GoRelease[]> {
  return httpJson<GoRelease[]>(LIST_URL);
}

/** stable 版本 → 版本对象（按版本降序） */
async function stableVersions(): Promise<{ raw: GoRelease; v: SdkVersion }[]> {
  const releases = await fetchReleases();
  const parsed: { raw: GoRelease; v: SdkVersion }[] = [];
  for (const r of releases) {
    if (!r.stable) continue;
    try {
      parsed.push({ raw: r, v: parseGoVersion('golang', r.version) });
    } catch {
      // 跳过无法解析的条目（如命名异常的旧版本）
    }
  }
  parsed.sort((a, b) => compareVersions(b.v, a.v));
  return parsed;
}

function pickFile(r: GoRelease, platform: VendorPlatform): GoFile | undefined {
  return r.files.find(
    (f) => f.kind === 'archive' && f.os === GO_OS[platform.os] && f.arch === GO_ARCH[platform.arch],
  );
}

function buildArtifact(r: GoRelease, f: GoFile, v: SdkVersion): ResolvedArtifact {
  return {
    vendorId: 'golang',
    version: v,
    dirName: `golang-${formatGoVersion(v)}`,
    displayName: `Go ${formatGoVersion(v)}`,
    downloadUrl: `https://go.dev/dl/${f.filename}`,
    checksum: { kind: 'sha256', expected: f.sha256 },
    archive: f.filename.endsWith('.zip') ? 'zip' : 'tar.gz',
  };
}

export const golangVendor: Vendor = {
  id: 'golang',
  label: 'Go (official)',
  sdk: 'go',
  supportsFullVersionList: true,

  /** go 无 major 概念：一条 minor 线（1.24）等价 java 的一个 major */
  async listMajors(): Promise<ReleaseLine[]> {
    const versions = await stableVersions();
    return groupMinorLines(
      versions.map(({ v }) => v),
      (v) => `${v.major}.${v.minor}`,
      compareVersions,
      formatGoVersion,
    );
  },

  async resolve(spec, platform): Promise<ResolvedArtifact> {
    if (spec.kind === 'lts' || spec.kind === 'major') {
      // go 语法不会产出 lts/major（java 专用），防御性拒绝
      throw new SdkvmError(`Unsupported version spec for Go: ${spec.kind}`);
    }
    const versions = await stableVersions();
    let target: { raw: GoRelease; v: SdkVersion } | undefined;
    if (spec.kind === 'latest') {
      target = versions[0];
    } else if (spec.kind === 'line') {
      target = versions.find((x) => x.v.major === spec.major && x.v.minor === spec.minor);
    } else {
      target = versions.find((x) => formatGoVersion(x.v) === spec.version);
    }
    if (!target) {
      throw new SdkvmError(`No Go release matches "${specLabel(spec)}"`, {
        hint: `Run \`${cmdPath('go')} ls -r\` to see available versions.`,
      });
    }
    const file = pickFile(target.raw, platform);
    if (!file) {
      throw new SdkvmError(
        `Go ${formatGoVersion(target.v)} has no archive for ${platform.os}/${platform.arch}`,
      );
    }
    return buildArtifact(target.raw, file, target.v);
  },
};
