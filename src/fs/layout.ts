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

/**
 * 归一化解压结果：单根目录探测 + 类型化 home 定位 + 可执行文件校验。
 * root 候选：解压目录里唯一子目录（常见 tarball 布局）或解压目录本身（散装文件）。
 */
export function normalizeExtracted(tmpDir: string, platform: Platform, type: SdkTypeId): NormalizedSdk {
  const spec = getSdkType(type);
  const entries = fs.readdirSync(tmpDir).filter((e) => e !== '._' && !e.startsWith('._'));
  // 忽略 macOS 元数据文件后判断唯一目录
  const real = entries.filter((e) => e !== '.DS_Store');
  let root: string;
  if (real.length === 1 && fs.statSync(path.join(tmpDir, real[0] as string)).isDirectory()) {
    root = path.join(tmpDir, real[0] as string);
  } else {
    root = tmpDir;
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
