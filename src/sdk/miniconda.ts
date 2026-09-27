import type { SdkVersion } from '../core/version.js';
import {
  compareVersions,
  formatMinicondaVersion,
  minicondaMatchesFull,
  parseMinicondaDirName,
  parseMinicondaUserSpec,
} from '../core/version.js';
import { MINICONDA_VENDORS } from '../vendor/index.js';
import type { SdkTypeSpec } from './types.js';

export const minicondaSdk: SdkTypeSpec = {
  id: 'miniconda',
  label: 'Miniconda',
  installDirName: 'minicondas',
  currentLinkName: 'current-miniconda',
  envVar: 'MINICONDA_HOME',
  supportsLts: false,
  vendors: MINICONDA_VENDORS,
  parseUserSpec: parseMinicondaUserSpec,
  matchesFull: minicondaMatchesFull,
  parseDirName: parseMinicondaDirName,
  formatVersion: formatMinicondaVersion,
  compareVersions,
  binRelPath(platform) {
    return platform.os === 'windows' ? 'Scripts/conda.exe' : 'bin/conda';
  },
  envBinSuffix(platform) {
    return platform.os === 'windows' ? '\\Scripts' : '/bin';
  },
  envPathSuffixes(platform) {
    if (platform.os !== 'windows') return ['/bin'];
    // python.exe 在 prefix 根目录，conda.exe 在 Scripts，DLL 在 Library\bin
    return ['', '\\Scripts', '\\Library\\bin'];
  },
  rcExtra(envVar) {
    // conda.sh 里的 conda 函数调用 $CONDA_EXE；不先导出的话 source 之后 conda 仍不可用。
    // 只 source conda.sh，不跑 `conda shell.bash hook`，因此不会自动 activate base。
    return [
      `export CONDA_EXE="$${envVar}/bin/conda"`,
      `export CONDA_PYTHON_EXE="$${envVar}/bin/python"`,
      `[ -f "$${envVar}/etc/profile.d/conda.sh" ] && . "$${envVar}/etc/profile.d/conda.sh"`,
    ].join('\n');
  },
  locateHome: (root) => root,
  versionCheck: { args: ['--version'], stream: 'stdout' },
};

export type { SdkVersion };
