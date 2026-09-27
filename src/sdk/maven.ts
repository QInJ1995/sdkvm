import type { SdkVersion } from '../core/version.js';
import {
  compareTaggedVersions,
  formatMavenVersion,
  parseMavenDirName,
  parseMavenUserSpec,
} from '../core/version.js';
import { MAVEN_VENDORS } from '../vendor/index.js';
import type { SdkTypeSpec } from './types.js';

export const mavenSdk: SdkTypeSpec = {
  id: 'maven',
  label: 'Maven',
  installDirName: 'mavens',
  currentLinkName: 'current-maven',
  envVar: 'MAVEN_HOME',
  supportsLts: false,
  requiresJdk: true,
  vendors: MAVEN_VENDORS,
  parseUserSpec: parseMavenUserSpec,
  matchesLoose: (v) => v.extra == null,
  parseDirName: parseMavenDirName,
  formatVersion: formatMavenVersion,
  compareVersions: compareTaggedVersions,
  binRelPath(platform) {
    return `bin/${platform.os === 'windows' ? 'mvn.cmd' : 'mvn'}`;
  },
  envBinSuffix(platform) {
    return platform.os === 'windows' ? '\\bin' : '/bin';
  },
  // 归档是单根 apache-maven-<version>/ 目录
  locateHome: (root) => root,
  versionCheck: { args: ['-version'], stream: 'stdout' },
};

export type { SdkVersion };
