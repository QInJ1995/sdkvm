import { httpText } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { cmdPath } from '../cli/cmdname.js';
import {
  compareVersions,
  formatMavenVersion,
  parseMavenVersion,
  type SdkVersion,
} from '../core/version.js';
import type { ReleaseLine, ResolvedArtifact, Vendor, VendorPlatform, VersionSpec } from './types.js';
import { groupMinorLines, specLabel } from './shared.js';

/** 列版本始终走官方 metadata；镜像只改归档 URL */
const META_URL =
  'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml';
const REPO = 'https://repo.maven.apache.org/maven2';

/** 新版 Central 旁路是 .sha512；3.8 及更早只有 .sha1，校验阶段再回退 */
const MIN_MAJOR = 3;

interface ListedVersion {
  raw: string;
  v: SdkVersion;
  stable: boolean;
}

function tryParse(raw: string): ListedVersion | null {
  try {
    const v = parseMavenVersion('maven', raw);
    if (v.major < MIN_MAJOR) return null;
    return { raw, v, stable: v.extra === null };
  } catch {
    return null;
  }
}

/** metadata 里的 <version>；忽略 <latest>/<release>（可能是预发布） */
async function fetchListed(): Promise<ListedVersion[]> {
  const xml = await httpText(META_URL);
  // 页面结构变化（如镜像返回 HTML 错误页）时明确报错，而不是静默给出空列表
  if (!xml.includes('<metadata')) {
    throw new SdkvmError('Maven metadata format unrecognized', { hint: META_URL });
  }
  const out: ListedVersion[] = [];
  for (const m of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
    const raw = m[1];
    if (!raw) continue;
    const parsed = tryParse(raw);
    if (parsed) out.push(parsed);
  }
  if (out.length === 0) {
    throw new SdkvmError('Maven metadata listed no versions', { hint: META_URL });
  }
  return out;
}

function stablesDesc(listed: ListedVersion[]): ListedVersion[] {
  return listed.filter((x) => x.stable).sort((a, b) => compareVersions(b.v, a.v));
}

function buildArtifact(v: SdkVersion, platform: VendorPlatform): ResolvedArtifact {
  const display = formatMavenVersion(v);
  const ext = platform.os === 'windows' ? 'zip' : 'tar.gz';
  const filename = `apache-maven-${display}-bin.${ext}`;
  const downloadUrl = `${REPO}/org/apache/maven/apache-maven/${display}/${filename}`;
  return {
    vendorId: 'maven',
    version: v,
    dirName: `maven-${display}`,
    displayName: `Apache Maven ${display}`,
    downloadUrl,
    checksum: { kind: 'sha512', url: `${downloadUrl}.sha512` },
    archive: ext === 'zip' ? 'zip' : 'tar.gz',
  };
}

export const mavenVendor: Vendor = {
  id: 'maven',
  label: 'Apache Maven',
  sdk: 'maven',
  supportsFullVersionList: true,

  /** 一条 minor 线（3.9）只含稳定版；预发布不单独成线 */
  async listMajors(): Promise<ReleaseLine[]> {
    const versions = stablesDesc(await fetchListed());
    return groupMinorLines(
      versions.map(({ v }) => v),
      (v) => `${v.major}.${v.minor}`,
      compareVersions,
      formatMavenVersion,
    );
  },

  async resolve(spec: VersionSpec, platform: VendorPlatform): Promise<ResolvedArtifact> {
    if (spec.kind === 'lts') {
      throw new SdkvmError('Unsupported version spec for Maven: lts', {
        hint: 'Maven has no lts alias — use "3", "3.9", "3.9.9", or "latest"',
      });
    }
    const listed = await fetchListed();
    const stables = stablesDesc(listed);
    let target: ListedVersion | undefined;
    if (spec.kind === 'latest') {
      target = stables[0];
    } else if (spec.kind === 'major') {
      target = stables.find((x) => x.v.major === spec.major);
    } else if (spec.kind === 'line') {
      target = stables.find((x) => x.v.major === spec.major && x.v.minor === spec.minor);
    } else {
      target = listed.find((x) => formatMavenVersion(x.v) === spec.version);
    }
    if (!target) {
      throw new SdkvmError(`No Maven release matches "${specLabel(spec)}"`, {
        hint: `Run \`${cmdPath('maven')} ls -r\` to see available versions.`,
      });
    }
    return buildArtifact(target.v, platform);
  },
};
