import type { SdkVersion } from '../core/version.js';
import { compareVersions, formatNodeVersion, parseNodeDirName, parseNodeUserSpec } from '../core/version.js';
import { NODE_VENDORS } from '../vendor/index.js';
import type { SdkTypeSpec } from './types.js';

/**
 * 偶数 major 才有 LTS 线。该线在发布年 10 月 1 日进入 LTS；
 * 4 月发布后到 9 月仍是 Current，`use lts` 不能选它。
 * 发布年 = major / 2 + 2013（Node 18 → 2022，Node 26 → 2026）。
 */
export function isNodeLtsMajor(major: number, now: Date = new Date()): boolean {
  if (!Number.isInteger(major) || major < 4 || major % 2 !== 0) return false;
  const releaseYear = major / 2 + 2013;
  return now.getTime() >= Date.UTC(releaseYear, 9, 1);
}

export const nodeSdk: SdkTypeSpec = {
  id: 'node',
  label: 'Node.js',
  installDirName: 'nodes',
  currentLinkName: 'current-node',
  envVar: 'NODE_HOME',
  supportsLts: true,
  isLtsMajor: (major) => isNodeLtsMajor(major),
  vendors: NODE_VENDORS,
  parseUserSpec: parseNodeUserSpec,
  parseDirName: parseNodeDirName,
  formatVersion: formatNodeVersion,
  compareVersions,
  binRelPath(platform) {
    // windows 归档没有 bin/，可执行文件在根目录
    return platform.os === 'windows' ? 'node.exe' : 'bin/node';
  },
  envBinSuffix(platform) {
    // 同上：windows 的 PATH entry 就是 %NODE_HOME% 本身
    return platform.os === 'windows' ? '' : '/bin';
  },
  // node 归档是单根 node-v{ver}-{plat}-{arch}/ 目录
  locateHome: (root) => root,
  versionCheck: { args: ['--version'], stream: 'stdout' },
};

export type { SdkVersion };
