import fs from 'node:fs';
import path from 'node:path';
import type { SdkVersion } from '../core/version.js';
import {
  compareVersions,
  formatVersion,
  LTS_MAJORS,
  parseDirName,
  parseUserSpec,
} from '../core/version.js';
import { JAVA_VENDORS } from '../vendor/index.js';
import type { SdkTypeSpec } from './types.js';

export const javaSdk: SdkTypeSpec = {
  id: 'java',
  label: 'Java (JDK)',
  installDirName: 'jdks',
  currentLinkName: 'current-java',
  envVar: 'JAVA_HOME',
  supportsLts: true,
  isLtsMajor: (major) => LTS_MAJORS.has(major),
  vendors: JAVA_VENDORS,
  parseUserSpec,
  parseDirName,
  formatVersion,
  compareVersions,
  binRelPath(platform) {
    return `bin/${platform.os === 'windows' ? 'java.exe' : 'java'}`;
  },
  envBinSuffix(platform) {
    return platform.os === 'windows' ? '\\bin' : '/bin';
  },
  locateHome(root) {
    // macOS JDK 是 bundle：环境语义目录在 Contents/Home。
    // 新版 Zulu 把 Contents 直接放在版本目录下；2026-04 之前的 macOS tar.gz
    // 还多包一层 zulu-<major>.jdk。
    const direct = path.join(root, 'Contents', 'Home');
    if (fs.existsSync(path.join(direct, 'bin'))) return direct;
    try {
      const bundles = fs
        .readdirSync(root)
        .filter((name) => name.endsWith('.jdk') || name.endsWith('.jre'))
        .sort();
      for (const name of bundles) {
        const nested = path.join(root, name, 'Contents', 'Home');
        if (fs.existsSync(path.join(nested, 'bin'))) return nested;
      }
    } catch {
      // root 不是目录，或扫描时被删掉
    }
    return root;
  },
  versionCheck: { args: ['-version'], stream: 'stderr' },
};

export type { SdkVersion };
