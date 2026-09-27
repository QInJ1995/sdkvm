import type { SdkVersion } from '../core/version.js';
import {
  comparePythonVersions,
  formatPythonVersion,
  isPythonStable,
  parsePythonDirName,
  parsePythonUserSpec,
} from '../core/version.js';
import { PYTHON_VENDORS } from '../vendor/index.js';
import type { SdkTypeSpec } from './types.js';

export const pythonSdk: SdkTypeSpec = {
  id: 'python',
  label: 'Python',
  installDirName: 'pythons',
  currentLinkName: 'current-python',
  envVar: 'PYTHON_HOME',
  supportsLts: false,
  vendors: PYTHON_VENDORS,
  parseUserSpec: parsePythonUserSpec,
  matchesLoose: isPythonStable,
  parseDirName: parsePythonDirName,
  formatVersion: formatPythonVersion,
  compareVersions: comparePythonVersions,
  binRelPath(platform) {
    return platform.os === 'windows' ? 'python.exe' : 'bin/python3';
  },
  envBinSuffix(platform) {
    return platform.os === 'windows' ? '' : '/bin';
  },
  envPathSuffixes(platform) {
    if (platform.os !== 'windows') return ['/bin'];
    // python.exe 在前缀根目录，pip.exe 在 Scripts
    return ['', '\\Scripts'];
  },
  locateHome: (root) => root,
  versionCheck: { args: ['--version'], stream: 'stdout' },
};

export type { SdkVersion };
