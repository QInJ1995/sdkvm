import fs from 'node:fs';
import path from 'node:path';
import type { SdkVersion } from './version.js';
import { paths } from './paths.js';
import { SdkvmError } from '../util/errors.js';
import { readCurrent } from '../fs/link.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { cmdPath } from '../cli/cmdname.js';

export interface InstalledSdk {
  type: SdkTypeId;
  version: SdkVersion;
  dirPath: string;
  /** 环境语义路径（JAVA_HOME / GO_HOME 等指向它；java macOS bundle → Contents/Home） */
  home: string;
}

/** 扫描安装根目录（如 ~/.sdkvm/jdks/），按版本升序 */
export function listInstalled(type: SdkTypeId): InstalledSdk[] {
  const spec = getSdkType(type);
  const root = paths.sdks(type);
  if (!fs.existsSync(root)) return [];
  const result: InstalledSdk[] = [];
  for (const name of fs.readdirSync(root)) {
    const version = spec.parseDirName(name);
    if (!version) continue;
    const dirPath = path.join(root, name);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    result.push({ type, version, dirPath, home: spec.locateHome(dirPath) });
  }
  result.sort((a, b) => spec.compareVersions(a.version, b.version));
  return result;
}

/** 当前 current 指向的已安装 SDK（无链接或悬空返回 null） */
export function currentSdk(type: SdkTypeId): InstalledSdk | null {
  const current = readCurrent(type);
  if (!current) return null;
  return (
    listInstalled(type).find(
      (j) =>
        j.home === current ||
        j.dirPath === current ||
        current.startsWith(j.dirPath + path.sep),
    ) ?? null
  );
}

/**
 * 按用户输入匹配已安装版本：
 * java: 21 → 该 major 最新 / lts / 21.0.5 前缀匹配；go: 1.24 → 该 minor 线最新 / latest / 1.24.5 精确。
 * miniconda full：py313、26.7.1-1 走 matchesFull。
 * python / maven / flutter 的 major、line、latest 跳过预发布。可带 vendor 前缀。
 */
export function findInstalled(type: SdkTypeId, specInput: string, vendorArg?: string): InstalledSdk {
  const spec = getSdkType(type);
  const { vendor: specVendor, spec: parsed } = spec.parseUserSpec(specInput);
  const vendor = vendorArg ?? specVendor;
  const all = listInstalled(type);
  const candidates = vendor ? all.filter((j) => j.version.vendor === vendor) : all;

  let matched: InstalledSdk[];
  const loose = (j: InstalledSdk) => (spec.matchesLoose ? spec.matchesLoose(j.version) : true);
  if (parsed.kind === 'major') {
    matched = candidates.filter((j) => loose(j) && j.version.major === parsed.major);
  } else if (parsed.kind === 'line') {
    matched = candidates.filter(
      (j) => loose(j) && j.version.major === parsed.major && j.version.minor === parsed.minor,
    );
  } else if (parsed.kind === 'lts') {
    const isLtsMajor = spec.isLtsMajor;
    if (!spec.supportsLts || !isLtsMajor) {
      throw new SdkvmError(`${spec.label} has no LTS releases`, {
        hint: `Try: ${cmdPath(type)} install latest`,
      });
    }
    matched = candidates.filter((j) => isLtsMajor(j.version.major));
  } else if (parsed.kind === 'latest') {
    matched = candidates.filter(loose); // 排序后取最后一个即最新；预发布可由 matchesLoose 排除
  } else {
    const v = parsed.version;
    matched = candidates.filter((j) => {
      if (spec.matchesFull) return spec.matchesFull(j.version, v);
      const f = spec.formatVersion(j.version);
      return f === v || f.startsWith(`${v}+`) || f.startsWith(`${v}.`);
    });
  }

  if (matched.length === 0) {
    const installedList = all
      .map((j) => `  ${j.version.vendor}-${spec.formatVersion(j.version)}`)
      .join('\n');
    const want = parsed.kind === 'full' ? parsed.version : specInput;
    throw new SdkvmError(`No installed ${spec.label} matches "${specInput}"`, {
      hint:
        (all.length > 0 ? `Installed:\n${installedList}\n` : '') +
        `Install one first: ${cmdPath(type)} install ${want}`,
    });
  }
  return matched[matched.length - 1] as InstalledSdk;
}
