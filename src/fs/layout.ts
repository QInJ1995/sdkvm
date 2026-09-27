import fs from 'node:fs';
import path from 'node:path';
import type { Platform } from '../core/platform.js';
import { SdkvmError } from '../util/errors.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';

export interface NormalizedSdk {
  /** 解压出的 SDK 根目录（含 release 文件那一层；java macOS 为 bundle 根） */
  root: string;
  /** 环境语义目录（JAVA_HOME / GO_HOME 等；java macOS bundle 下为 root/Contents/Home） */
  home: string;
}

/** tar/zip 解出来的元数据，不是 SDK 根目录。 */
function isArchiveMeta(name: string): boolean {
  return (
    name === '.DS_Store' ||
    name === '__MACOSX' ||
    name.startsWith('._') ||
    name.startsWith('PaxHeader') ||
    name.startsWith('@PaxHeader')
  );
}

function hasSdkBin(
  dir: string,
  platform: Platform,
  type: SdkTypeId,
): boolean {
  const spec = getSdkType(type);
  return fs.existsSync(path.join(spec.locateHome(dir), spec.binRelPath(platform)));
}

/**
 * 归一化解压结果：单根目录探测 + 类型化 home 定位 + 可执行文件校验。
 * 常见 tarball 只有一个子目录。旁边如果还有许可证或 __MACOSX，改找真正含可执行文件的那一层。
 */
export function normalizeExtracted(tmpDir: string, platform: Platform, type: SdkTypeId): NormalizedSdk {
  const spec = getSdkType(type);
  const entries = fs.readdirSync(tmpDir).filter((name) => !isArchiveMeta(name));
  const dirs = entries.filter((name) => {
    try {
      return fs.statSync(path.join(tmpDir, name)).isDirectory();
    } catch {
      return false;
    }
  });

  let root = tmpDir;
  if (dirs.length === 1 && entries.length === 1) {
    root = path.join(tmpDir, dirs[0] as string);
  } else {
    const candidates = [tmpDir, ...dirs.map((name) => path.join(tmpDir, name))];
    root = candidates.find((dir) => hasSdkBin(dir, platform, type)) ?? tmpDir;
  }

  const home = spec.locateHome(root);
  const bin = path.join(home, spec.binRelPath(platform));
  if (!fs.existsSync(bin)) {
    throw new SdkvmError(`Does not look like a valid ${spec.label} (bin not found)`, {
      hint: `expected ${bin}`,
    });
  }
  return { root, home };
}
