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

/**
 * 解压结果必须全部落在 destDir 内（zip-slip / tar 符号链接穿越的收尾防线）。
 * 外部 tar/unzip 对 `..` 成员与符号链接的处理因实现而异，
 * 在把根目录改名进安装目录之前做一次包含性审计：条目不得逃逸、符号链接不得外指。
 */
export function assertContained(destDir: string, root: string): void {
  const base = path.resolve(destDir);
  const within = (p: string): boolean => {
    const resolved = path.resolve(p);
    return resolved === base || resolved.startsWith(base + path.sep);
  };
  if (!within(root)) {
    throw new SdkvmError('Archive root lies outside the extraction directory', { hint: root });
  }
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, ent.name);
      if (!within(entryPath)) {
        throw new SdkvmError(`Archive entry escapes the extraction directory: ${ent.name}`, {
          hint: entryPath,
        });
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(entryPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let real: string | null = null;
        try {
          real = fs.realpathSync(entryPath);
        } catch {
          real = null;
        }
        if (!real || !within(real)) {
          throw new SdkvmError(`Archive symlink points outside the extraction directory: ${ent.name}`, {
            hint: real ?? entryPath,
          });
        }
      }
      if (st.isDirectory()) walk(entryPath);
    }
  };
  walk(destDir);
}
