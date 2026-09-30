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
      // lstat：指向目录的符号链接不能当解压根。stat 会跟着链接走进去，
      // 随后把链接本身 rename 进安装目录，真正的文件还留在临时目录里被清掉
      return fs.lstatSync(path.join(tmpDir, name)).isDirectory();
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
/** 符号链接返回链接文本；Windows junction（lstat 不是 symlink）同样返回文本。
 *  普通目录返回 undefined。读不出文本的链接返回 null。 */
function reparseText(entryPath: string, st: fs.Stats): string | null | undefined {
  if (st.isSymbolicLink()) {
    try {
      return fs.readlinkSync(entryPath);
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32' && st.isDirectory()) {
    try {
      return fs.readlinkSync(entryPath);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function assertContained(destDir: string, root: string): void {
  const base = path.resolve(destDir);
  const within = (p: string): boolean => {
    const resolved = path.resolve(p);
    return resolved === base || resolved.startsWith(base + path.sep);
  };
  // 符号链接审计两侧都要 realpath：macOS 的 /tmp 是 /private/tmp 的链接，
  // 未解析的 base 与已解析的 realpath 比较会把合法的包内相对链接误判成越界
  const realBase = (() => {
    try {
      return fs.realpathSync(base);
    } catch {
      return base;
    }
  })();
  const withinReal = (p: string): boolean =>
    p === realBase || p.startsWith(realBase + path.sep);
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
      // Windows junction 的 lstat 往往不是 symlink、但是目录。readlink 能读出目标。
      // 当成普通目录 walk 进去时，path.resolve 不解析重解析点，越界目标会被留下。
      const linkText = reparseText(entryPath, st);
      if (linkText !== undefined) {
        let real: string | null = null;
        try {
          real = fs.realpathSync(entryPath);
        } catch {
          real = null;
        }
        // 悬空链接（目标不存在）无法 realpath：按链接文本做词法判断——
        // 相对目标 resolve 后仍须落在包内；绝对目标才视为越界
        if (!real) {
          if (linkText == null) continue;
          const resolved = path.isAbsolute(linkText)
            ? path.resolve(linkText)
            : path.resolve(path.dirname(entryPath), linkText);
          // 词法 resolve 的结果带的是 destDir 的原始拼写（如 macOS 的 /var/...），
          // 与 realpath 基（/private/var/...）拼写不同不代表越界：两个基任一命中即可
          if (!withinReal(resolved) && !within(resolved)) {
            throw new SdkvmError(`Archive symlink points outside the extraction directory: ${ent.name}`, {
              hint: `${linkText} → ${resolved}`,
            });
          }
          continue;
        }
        if (!withinReal(real)) {
          throw new SdkvmError(`Archive symlink points outside the extraction directory: ${ent.name}`, {
            hint: real,
          });
        }
        continue;
      }
      if (st.isDirectory()) walk(entryPath);
    }
  };
  walk(destDir);
}
