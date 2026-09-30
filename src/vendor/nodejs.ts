import { parseSha256SumLine } from '../net/checksum.js';
import { httpJson, httpText } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { compareVersions, formatNodeVersion, parseNodeVersion } from '../core/version.js';
import type { SdkVersion } from '../core/version.js';
import type { ReleaseLine, ResolvedArtifact, Vendor, VendorPlatform, VersionSpec } from './types.js';

/** nodejs.org/dist 官方分发根（index.json 与 SHASUMS256.txt 永远走官方，镜像只替换归档 URL） */
const DIST = 'https://nodejs.org/dist';

interface NodeIndexEntry {
  version: string; // "v22.20.0"
  lts: false | string; // false = Current 通道，字符串 = LTS 代号（"Jod"）
  date: string;
  npm: string;
}

/** lts 字段只有字符串代号才算 LTS：false 明确是 Current，字段缺失/异常值不得当作 LTS */
function isLtsEntry(e: NodeIndexEntry): boolean {
  return typeof e.lts === 'string';
}

function tryParseEntry(e: NodeIndexEntry): SdkVersion | null {
  try {
    return parseNodeVersion('nodejs', e.version);
  } catch {
    return null;
  }
}

/** 官方发布索引，按版本降序（自行重排，不信任远端顺序） */
async function fetchIndex(): Promise<NodeIndexEntry[]> {
  const data = await httpJson<unknown>(`${DIST}/index.json`);
  // 网关错误页/结构变更时给出可读错误，而不是 TypeError
  if (!Array.isArray(data)) {
    throw new SdkvmError('nodejs.org index has an unexpected structure');
  }
  return (data as NodeIndexEntry[])
    .map((e) => ({ e, v: tryParseEntry(e) }))
    .filter((x): x is { e: NodeIndexEntry; v: SdkVersion } => x.v !== null)
    .sort((a, b) => compareVersions(b.v, a.v))
    .map((x) => x.e);
}

/** 解析 SHASUMS256.txt：精确文件名（含扩展名偏好）与 sha256 一次拿全 */
async function fetchShasums(version: string): Promise<Map<string, string>> {
  const text = await httpText(`${DIST}/${version}/SHASUMS256.txt`);
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const row = parseSha256SumLine(line);
    if (row) sums.set(row.name, row.hash);
  }
  return sums;
}

export const nodejsVendor: Vendor = {
  id: 'nodejs',
  label: 'Node.js',
  sdk: 'node',
  supportsFullVersionList: true,

  async listMajors(): Promise<ReleaseLine[]> {
    const entries = await fetchIndex();
    const lines: ReleaseLine[] = [];
    const seen = new Set<number>();
    for (const e of entries) {
      const v = tryParseEntry(e);
      if (!v || seen.has(v.major)) continue; // 降序遍历，首个即该 major 线最新
      seen.add(v.major);
      lines.push({ key: String(v.major), lts: isLtsEntry(e), latestFullVersion: formatNodeVersion(v) });
    }
    return lines;
  },

  async resolve(spec: VersionSpec, platform: VendorPlatform): Promise<ResolvedArtifact> {
    const entries = await fetchIndex();
    let entry: NodeIndexEntry | undefined;
    if (spec.kind === 'latest') {
      entry = entries[0];
    } else if (spec.kind === 'lts') {
      entry = entries.find((e) => isLtsEntry(e));
    } else if (spec.kind === 'major') {
      entry = entries.find((e) => tryParseEntry(e)?.major === spec.major);
    } else if (spec.kind === 'full') {
      entry = entries.find((e) => {
        const v = tryParseEntry(e);
        return v !== null && formatNodeVersion(v) === spec.version.replace(/^v/, '');
      });
    }
    if (!entry) {
      const what = spec.kind === 'full' ? spec.version : spec.kind === 'major' ? String(spec.major) : spec.kind;
      throw new SdkvmError(`No Node.js release matches "${what}"`, {
        hint: 'Run `sdkvm node ls -r` to list available major lines',
      });
    }

    const version = parseNodeVersion('nodejs', entry.version);
    const sums = await fetchShasums(entry.version);
    // 归档命名 node-v{ver}-{darwin|linux|win}-{x64|arm64}；unix 同版本 xz/gz 常并存，优先 xz
    const plat = platform.os === 'mac' ? 'darwin' : platform.os === 'linux' ? 'linux' : 'win';
    const arch = platform.arch === 'aarch64' ? 'arm64' : 'x64';
    const base = `node-${entry.version}-${plat}-${arch}`;
    const candidates = platform.os === 'windows' ? [`${base}.zip`] : [`${base}.tar.xz`, `${base}.tar.gz`];
    const filename = candidates.find((f) => sums.has(f));
    if (!filename) {
      throw new SdkvmError(`No Node.js ${formatNodeVersion(version)} archive for ${platform.os}/${platform.arch}`, {
        hint: 'Run `sdkvm node ls -r` and pick a line that ships this platform (arm64 needs newer lines)',
      });
    }
    const archive = filename.endsWith('.zip') ? ('zip' as const) : filename.endsWith('.tar.xz') ? ('tar.xz' as const) : ('tar.gz' as const);
    const display = formatNodeVersion(version);
    return {
      vendorId: 'nodejs',
      version,
      dirName: `nodejs-${display}`,
      displayName: `Node.js ${display}`,
      downloadUrl: `${DIST}/${entry.version}/${filename}`,
      checksum: { kind: 'sha256', expected: sums.get(filename) },
      archive,
    };
  },
};
