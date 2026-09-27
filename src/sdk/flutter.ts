import type { SdkVersion } from '../core/version.js';
import {
  compareTaggedVersions,
  formatFlutterVersion,
  parseFlutterDirName,
  parseFlutterUserSpec,
} from '../core/version.js';
import { FLUTTER_VENDORS } from '../vendor/index.js';
import type { SdkTypeSpec } from './types.js';

export const flutterSdk: SdkTypeSpec = {
  id: 'flutter',
  label: 'Flutter',
  installDirName: 'flutters',
  currentLinkName: 'current-flutter',
  envVar: 'FLUTTER_HOME',
  supportsLts: false,
  vendors: FLUTTER_VENDORS,
  parseUserSpec: parseFlutterUserSpec,
  matchesLoose: (v) => v.extra == null,
  parseDirName: parseFlutterDirName,
  formatVersion: formatFlutterVersion,
  compareVersions: compareTaggedVersions,
  binRelPath(platform) {
    return `bin/${platform.os === 'windows' ? 'flutter.bat' : 'flutter'}`;
  },
  envBinSuffix(platform) {
    return platform.os === 'windows' ? '\\bin' : '/bin';
  },
  // flutter 归档是单根 flutter/ 目录，无 macOS bundle 概念
  locateHome: (root) => root,
  versionCheck: { args: ['--version'], stream: 'stdout' },
};

export type { SdkVersion };
