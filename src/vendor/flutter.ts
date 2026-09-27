import type { ReleaseLine, ResolvedArtifact, Vendor, VendorPlatform, VersionSpec } from './types.js';
import { httpJson } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { compareVersions, formatFlutterVersion, parseFlutterVersion, type SdkVersion } from '../core/version.js';
import { detectPlatform } from '../core/platform.js';
import { cmdPath } from '../cli/cmdname.js';

/** 官方发布清单按 OS 分文件（releases_macos.json 等）；归档 URL = manifest.base_url + '/' + archive */
const MANIFEST_BASE = 'https://storage.googleapis.com/flutter_infra_release/releases';

/** 平台命名差异：os mac→macos；arch 与 dart_sdk_arch 字段一致（aarch64→arm64） */
const FLUTTER_OS = { mac: 'macos', linux: 'linux', windows: 'windows' } as const;
const FLUTTER_ARCH = { aarch64: 'arm64', x64: 'x64' } as const;

interface FlutterRelease {
  hash: string;
  channel: 'stable' | 'beta' | 'dev';
  version: string;
  dart_sdk_version: string;
  dart_sdk_arch: string;
  release_date: string;
  archive: string;
  sha256: string;
}

interface FlutterManifest {
  base_url: string;
  current_release: Record<string, string>;
  releases: FlutterRelease[];
}

/** 当前平台可用的全部版本（任意通道、按版本降序）；stable 为其 stable 子集 */
async function fetchEntries(platform: VendorPlatform): Promise<{
  baseUrl: string;
  stable: { raw: FlutterRelease; v: SdkVersion }[];
  all: { raw: FlutterRelease; v: SdkVersion }[];
}> {
  const manifest = await httpJson<FlutterManifest>(`${MANIFEST_BASE}/releases_${FLUTTER_OS[platform.os]}.json`);
  const arch = FLUTTER_ARCH[platform.arch];
  const parsed: { raw: FlutterRelease; v: SdkVersion }[] = [];
  for (const r of manifest.releases) {
    if (r.dart_sdk_arch !== arch) continue;
    try {
      parsed.push({ raw: r, v: parseFlutterVersion('flutter', r.version) });
    } catch {
      // 跳过无法解析的旧格式条目
    }
  }
  parsed.sort((a, b) => compareVersions(b.v, a.v));
  return {
    baseUrl: manifest.base_url,
    stable: parsed.filter((x) => x.raw.channel === 'stable' && x.v.extra == null),
    all: parsed,
  };
}

function buildArtifact(
  baseUrl: string,
  r: FlutterRelease,
  v: SdkVersion,
  platform: VendorPlatform,
): ResolvedArtifact {
  return {
    vendorId: 'flutter',
    version: v,
    dirName: `flutter-${formatFlutterVersion(v)}`,
    displayName: `Flutter ${formatFlutterVersion(v)}`,
    downloadUrl: `${baseUrl}/${r.archive}`,
    checksum: { kind: 'sha256', expected: r.sha256 },
    archive: platform.os === 'linux' ? 'tar.xz' : 'zip',
  };
}

function specLabel(spec: VersionSpec): string {
  if (spec.kind === 'line') return `${spec.major}.${spec.minor}`;
  if (spec.kind === 'full') return spec.version;
  return 'latest';
}

export const flutterVendor: Vendor = {
  id: 'flutter',
  label: 'Flutter (official)',
  sdk: 'flutter',
  supportsFullVersionList: true,

  /** 一条 minor 线（3.47）等价 java 的一个 major；latest/line 只看 stable 通道 */
  async listMajors(): Promise<ReleaseLine[]> {
    const { stable } = await fetchEntries(detectPlatform());
    const lines = new Map<string, SdkVersion>();
    for (const { v } of stable) {
      const key = `${v.major}.${v.minor}`;
      const cur = lines.get(key);
      if (!cur || compareVersions(v, cur) > 0) lines.set(key, v);
    }
    return [...lines.entries()]
      .map(([key, v]) => ({ key, v }))
      .sort((a, b) => compareVersions(b.v, a.v))
      .map(({ key, v }) => ({ key, lts: false, latestFullVersion: formatFlutterVersion(v) }));
  },

  async resolve(spec, platform): Promise<ResolvedArtifact> {
    if (spec.kind === 'lts' || spec.kind === 'major') {
      // flutter 语法不会产出 lts/major（java 专用），防御性拒绝
      throw new SdkvmError(`Unsupported version spec for Flutter: ${spec.kind}`);
    }
    const { baseUrl, stable, all } = await fetchEntries(platform);
    if (all.length === 0) {
      // 官方在 linux/windows 只发布 x64 归档
      throw new SdkvmError(
        `No Flutter archive for ${platform.os}/${platform.arch} (official releases are x64-only on Linux/Windows)`,
      );
    }
    let target: { raw: FlutterRelease; v: SdkVersion } | undefined;
    if (spec.kind === 'latest') {
      target = stable[0];
    } else if (spec.kind === 'line') {
      target = stable.find((x) => x.v.major === spec.major && x.v.minor === spec.minor);
    } else {
      // 精确匹配：优先 stable，其次任意通道（beta 以完整版本号安装）
      target =
        stable.find((x) => formatFlutterVersion(x.v) === spec.version) ??
        all.find((x) => formatFlutterVersion(x.v) === spec.version);
    }
    if (!target) {
      throw new SdkvmError(`No Flutter release matches "${specLabel(spec)}"`, {
        hint: `Run \`${cmdPath('flutter')} ls -r\` to see available versions.`,
      });
    }
    return buildArtifact(baseUrl, target.raw, target.v, platform);
  },
};
