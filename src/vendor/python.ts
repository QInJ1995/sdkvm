import { parseSha256SumLine } from '../net/checksum.js';
import { httpJson, httpText } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { cmdPath } from '../cli/cmdname.js';
import { detectPlatform, hostLibc } from '../core/platform.js';
import {
  comparePythonVersions,
  formatPythonVersion,
  isPythonStable,
  parsePythonVersion,
  type SdkVersion,
} from '../core/version.js';
import type { ReleaseLine, ResolvedArtifact, Vendor, VendorPlatform, VersionSpec } from './types.js';
import { specLabel } from './shared.js';

/** 版本清单。SHA256SUMS 与这份 JSON 始终走官方；镜像只改归档 URL。 */
export const CPYTHON_LATEST_JSON =
  'https://raw.githubusercontent.com/astral-sh/python-build-standalone/latest-release/latest-release.json';

/** 归档下载根。镜像把这一段换成镜像根，保留 /{tag}/{filename}。 */
export const CPYTHON_DOWNLOAD_PREFIX =
  'https://github.com/astral-sh/python-build-standalone/releases/download';

/** 基线三元组。不含 x86_64_v2/v3/v4、musl、freethreaded。 */
const BASELINE_TRIPLES = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
]);

const FILE_RE =
  /^cpython-(\d+)\.(\d+)\.(\d+)((?:a|b|rc)\d+)?\+\d+-([a-z0-9_]+(?:-[a-z0-9_]+)*)-install_only(_stripped)?\.tar\.gz$/;

export interface PythonFile {
  filename: string;
  version: SdkVersion;
  sha256: string;
  triple: string;
  stripped: boolean;
}

interface LatestRelease {
  tag?: string;
  asset_url_prefix?: string;
}

interface GithubRelease {
  tag_name?: string;
}

export function pythonTriple(platform: VendorPlatform): string {
  if (platform.os === 'mac') {
    return platform.arch === 'aarch64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform.os === 'linux') {
    return platform.arch === 'aarch64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  return platform.arch === 'aarch64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
}

/** 从 SHA256SUMS 抽出基线 install_only 归档。其它变体直接丢掉。 */
export function parsePythonSums(text: string): PythonFile[] {
  const out: PythonFile[] = [];
  for (const line of text.split('\n')) {
    const row = parseSha256SumLine(line);
    if (!row) continue;
    const parsed = FILE_RE.exec(row.name);
    if (!parsed?.[1] || !parsed[2] || !parsed[3] || !parsed[5]) continue;
    if (!BASELINE_TRIPLES.has(parsed[5])) continue;
    const token = `${parsed[1]}.${parsed[2]}.${parsed[3]}${parsed[4] ?? ''}`;
    let version: SdkVersion;
    try {
      version = parsePythonVersion('cpython', token);
    } catch {
      continue;
    }
    out.push({
      filename: row.name,
      version,
      sha256: row.hash,
      triple: parsed[5],
      stripped: parsed[6] === '_stripped',
    });
  }
  return out;
}

/** 同一版本、同一三元组只留一份，有 stripped 就用它。 */
export function preferStripped(files: PythonFile[]): PythonFile[] {
  const map = new Map<string, PythonFile>();
  for (const file of files) {
    const key = `${file.triple}\0${formatPythonVersion(file.version)}`;
    const cur = map.get(key);
    if (!cur || (file.stripped && !cur.stripped)) map.set(key, file);
  }
  return [...map.values()];
}

function versionsDesc(files: PythonFile[]): SdkVersion[] {
  const map = new Map<string, SdkVersion>();
  for (const file of files) {
    const key = formatPythonVersion(file.version);
    if (!map.has(key)) map.set(key, file.version);
  }
  return [...map.values()].sort((a, b) => comparePythonVersions(b, a));
}

/** latest / major / line 只在稳定版里取最新；full 可以是预发布。输入不必预先排序。 */
export function pickPythonVersion(versions: SdkVersion[], spec: VersionSpec): SdkVersion | undefined {
  const ordered = [...versions].sort((a, b) => comparePythonVersions(b, a));
  const stable = ordered.filter(isPythonStable);
  if (spec.kind === 'latest') return stable[0];
  if (spec.kind === 'major') return stable.find((v) => v.major === spec.major);
  if (spec.kind === 'line') {
    return stable.find((v) => v.major === spec.major && v.minor === spec.minor);
  }
  if (spec.kind === 'full') return ordered.find((v) => formatPythonVersion(v) === spec.version);
  return undefined;
}

/**
 * 当前平台实际有归档的稳定 minor 线。只有预发布的线不列出。
 * 不用 shared 的 groupMinorLines：预发布要先滤掉再取线首，语义与其它 vendor 不同。
 */
export function pythonReleaseLines(files: PythonFile[], platform: VendorPlatform): ReleaseLine[] {
  const triple = pythonTriple(platform);
  const versions = versionsDesc(preferStripped(files.filter((file) => file.triple === triple))).filter(
    isPythonStable,
  );
  const lines: ReleaseLine[] = [];
  const seen = new Set<string>();
  for (const v of versions) {
    const key = `${v.major}.${v.minor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ key, lts: false, latestFullVersion: formatPythonVersion(v) });
  }
  return lines;
}

function filesFor(files: PythonFile[], platform: VendorPlatform): PythonFile[] {
  const triple = pythonTriple(platform);
  return preferStripped(files.filter((file) => file.triple === triple));
}

function buildArtifact(file: PythonFile, prefix: string): ResolvedArtifact {
  const display = formatPythonVersion(file.version);
  return {
    vendorId: 'cpython',
    version: file.version,
    dirName: `cpython-${display}`,
    displayName: `Python ${display}`,
    downloadUrl: `${prefix}/${file.filename}`,
    checksum: { kind: 'sha256', expected: file.sha256 },
    archive: 'tar.gz',
  };
}

/** 历史 release 标签（full 版本回退用；GitHub releases 按时间倒序，tag 为 YYYYMMDD 日期式） */
async function recentReleaseTags(): Promise<string[]> {
  let releases: GithubRelease[];
  try {
    releases = await httpJson<GithubRelease[]>(
      'https://api.github.com/repos/astral-sh/python-build-standalone/releases?per_page=5',
    );
  } catch {
    // 未认证 GitHub API 限流（403）或不可达：回退列表为空即可，
    // 让调用方走正常的"未找到版本"报错，而不是把裸 HttpError 抛给用户
    return [];
  }
  return releases.map((r) => r.tag_name ?? '').filter((t) => /^\d{8}$/.test(t));
}

/** 取某个 tag 的 SHA256SUMS；拉不到或为空返回 null */
async function fetchTagRelease(tag: string): Promise<{ prefix: string; files: PythonFile[] } | null> {
  const prefix = `${CPYTHON_DOWNLOAD_PREFIX}/${tag}`;
  let text: string;
  try {
    text = await httpText(`${prefix}/SHA256SUMS`);
  } catch {
    return null;
  }
  const files = parsePythonSums(text);
  return files.length > 0 ? { prefix, files } : null;
}

/** full 规格在最新 release 缺失时，回退查最近几个历史 release（老 patch 只在旧 tag 里） */
async function resolveFromRecentTag(
  spec: VersionSpec & { kind: 'full' },
  platform: VendorPlatform,
): Promise<ResolvedArtifact | null> {
  for (const tag of await recentReleaseTags()) {
    const hit = await fetchTagRelease(tag);
    if (!hit) continue;
    const forPlatform = filesFor(hit.files, platform);
    const target = pickPythonVersion(versionsDesc(forPlatform), spec);
    if (!target) continue;
    const file = forPlatform.find(
      (item) => formatPythonVersion(item.version) === formatPythonVersion(target),
    );
    if (file) return buildArtifact(file, hit.prefix);
  }
  return null;
}

async function fetchRelease(): Promise<{ prefix: string; files: PythonFile[] }> {
  const meta = await httpJson<LatestRelease>(CPYTHON_LATEST_JSON);
  const prefix = (meta.asset_url_prefix ?? (meta.tag ? `${CPYTHON_DOWNLOAD_PREFIX}/${meta.tag}` : '')).replace(
    /\/+$/,
    '',
  );
  if (!prefix.startsWith(`${CPYTHON_DOWNLOAD_PREFIX}/`)) {
    throw new SdkvmError('Unexpected python-build-standalone download prefix', {
      hint: prefix || 'latest-release.json has no asset_url_prefix',
    });
  }
  const text = await httpText(`${prefix}/SHA256SUMS`);
  const files = parsePythonSums(text);
  if (files.length === 0) {
    throw new SdkvmError('Python release index has no installable builds', {
      hint: 'SHA256SUMS did not list a baseline install_only archive.',
    });
  }
  return { prefix, files };
}

export const cpythonVendor: Vendor = {
  id: 'cpython',
  label: 'CPython',
  sdk: 'python',
  supportsFullVersionList: true,

  async listMajors(): Promise<ReleaseLine[]> {
    const { files } = await fetchRelease();
    return pythonReleaseLines(files, detectPlatform());
  },

  async resolve(spec: VersionSpec, platform: VendorPlatform): Promise<ResolvedArtifact> {
    if (spec.kind === 'lts') {
      throw new SdkvmError('Unsupported version spec for Python: lts', {
        hint: 'Python has no lts alias — use "3", "3.12", "3.12.7", or "latest"',
      });
    }
    const { prefix, files } = await fetchRelease();
    const anywhere = preferStripped(files);
    const forPlatform = filesFor(files, platform);
    const target = pickPythonVersion(versionsDesc(forPlatform), spec);
    if (!target) {
      const existsElsewhere = pickPythonVersion(versionsDesc(anywhere), spec);
      if (!existsElsewhere && spec.kind === 'full') {
        const fromTag = await resolveFromRecentTag(spec, platform);
        if (fromTag) return fromTag;
      }
      if (existsElsewhere) {
        // musl 主机：不是"没这个版本"，是本基线只收 glibc 构建——把真实原因说出来
        const muslNote =
          platform.os === 'linux' && hostLibc(platform.arch) === 'musl'
            ? ' musl builds do exist upstream but are outside this baseline; on Alpine use the distro python package.'
            : '';
        throw new SdkvmError(
          `No Python ${formatPythonVersion(existsElsewhere)} archive for ${platform.os}/${platform.arch}`,
          { hint: `Run \`${cmdPath('python')} ls -r\` and pick a release that ships this platform.${muslNote}` },
        );
      }
      throw new SdkvmError(`No Python release matches "${specLabel(spec)}"`, {
        hint: `Run \`${cmdPath('python')} ls -r\` to see available versions.`,
      });
    }
    const file = forPlatform.find((item) => formatPythonVersion(item.version) === formatPythonVersion(target));
    if (!file) {
      throw new SdkvmError(
        `No Python ${formatPythonVersion(target)} archive for ${platform.os}/${platform.arch}`,
        { hint: `Run \`${cmdPath('python')} ls -r\` and pick a release that ships this platform.` },
      );
    }
    return buildArtifact(file, prefix);
  },
};
