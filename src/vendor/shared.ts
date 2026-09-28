import type { ReleaseLine } from './types.js';
import type { SdkVersion, VersionSpec } from '../core/version.js';

/** 用户规格回显（错误信息用）：major/line/full 还原为输入样式，latest/lts 原样 */
export function specLabel(spec: VersionSpec): string {
  if (spec.kind === 'major') return String(spec.major);
  if (spec.kind === 'line') return `${spec.major}.${spec.minor}`;
  if (spec.kind === 'full') return spec.version;
  return spec.kind;
}

/**
 * 按 minor 线分组、各线取最新，输出按线内最新版本降序。
 * golang / flutter / maven / miniconda 的 listMajors 同形；
 * python 因预发布不参与取线，保留自己的实现。
 */
export function groupMinorLines(
  versions: readonly SdkVersion[],
  keyOf: (v: SdkVersion) => string,
  compare: (a: SdkVersion, b: SdkVersion) => number,
  format: (v: SdkVersion) => string,
): ReleaseLine[] {
  const lines = new Map<string, SdkVersion>();
  for (const v of versions) {
    const key = keyOf(v);
    const cur = lines.get(key);
    if (!cur || compare(v, cur) > 0) lines.set(key, v);
  }
  return [...lines.values()]
    .sort((a, b) => compare(b, a))
    .map((v) => ({ key: keyOf(v), lts: false, latestFullVersion: format(v) }));
}
