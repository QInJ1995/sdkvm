import fs from 'node:fs';
import path from 'node:path';
import { JAVA_VENDOR_IDS } from './version.js';
import { acquireLock, releaseLock } from './lock.js';
import { ensureLayout, paths } from './paths.js';
import { SdkvmError } from '../util/errors.js';
import { log } from '../ui/log.js';

export interface SdkvmConfig {
  version: 1;
  defaultVendor: string;
  /** vendor id（跨全部 SDK 类型全局唯一）→ 镜像根 URL */
  mirror: Partial<Record<string, string | null>>;
  /** 用户自定义 npm registry 名 → URL（sdkvm nrm add/del） */
  npmRegistries: Record<string, string>;
  /** 用户自定义 Maven 依赖仓库名 → URL（sdkvm mrm add/del） */
  mavenRegistries: Record<string, string>;
  /** 自定义 settings.xml 绝对路径；空串表示 ~/.m2/settings.xml */
  mavenSettings: string;
}

export const DEFAULT_CONFIG: SdkvmConfig = {
  version: 1,
  defaultVendor: 'temurin',
  mirror: {},
  npmRegistries: {},
  mavenRegistries: {},
  mavenSettings: '',
};

function blankConfig(defaultVendor = 'temurin'): SdkvmConfig {
  return {
    version: 1,
    defaultVendor,
    mirror: {},
    npmRegistries: {},
    mavenRegistries: {},
    mavenSettings: '',
  };
}

export function loadConfig(): SdkvmConfig {
  const file = paths.config();
  if (!fs.existsSync(file)) return blankConfig();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // IO 错误（Windows 杀毒共享冲突 / 权限）不是配置损坏：上抛而不是备份重置，
    // 否则完好的 config.json 会被改名 .bak，下一次写入就把用户配置全部冲掉。
    throw new SdkvmError(`Cannot read config at ${file}`, {
      hint: `${(err as Error).message}. Fix the permission or remove the file manually.`,
    });
  }
  let parsed: Partial<SdkvmConfig> | null = null;
  let broken = false;
  try {
    parsed = JSON.parse(raw) as Partial<SdkvmConfig>;
  } catch {
    broken = true;
  }
  // 顶层必须是对象：null / 数组 / 标量都是合法 JSON，但不是配置——同样按损坏处理
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) broken = true;
  if (broken) {
    const bak = `${file}.bak`;
    try {
      fs.renameSync(file, bak);
      log.warn(`config.json was corrupted; backed up to ${bak}, using defaults`);
    } catch (err) {
      // 备份失败也要让用户知道，静默换默认值会被当成配置丢失
      log.warn(
        `config.json was corrupted and could not be backed up (${(err as Error).message}); using defaults`,
      );
    }
    return blankConfig();
  }
  // broken 已在上面提前返回，这里 parsed 一定是对象；?? {} 仅为满足类型收窄
  const parsedConfig = parsed ?? {};
  const config = blankConfig(
    parsedConfig.defaultVendor &&
      (JAVA_VENDOR_IDS as readonly string[]).includes(parsedConfig.defaultVendor)
      ? parsedConfig.defaultVendor
      : 'temurin',
  );
  if (parsedConfig.mirror && typeof parsedConfig.mirror === 'object') {
    for (const [id, v] of Object.entries(parsedConfig.mirror)) {
      if (typeof v === 'string' && v.length > 0) config.mirror[id] = v;
    }
  }
  if (parsedConfig.npmRegistries && typeof parsedConfig.npmRegistries === 'object') {
    for (const [id, v] of Object.entries(parsedConfig.npmRegistries)) {
      if (typeof v === 'string' && v.length > 0) config.npmRegistries[id] = v;
    }
  }
  if (parsedConfig.mavenRegistries && typeof parsedConfig.mavenRegistries === 'object') {
    for (const [id, v] of Object.entries(parsedConfig.mavenRegistries)) {
      if (typeof v === 'string' && v.length > 0) config.mavenRegistries[id] = v;
    }
  }
  if (typeof parsedConfig.mavenSettings === 'string') {
    config.mavenSettings = parsedConfig.mavenSettings.trim();
  }
  return config;
}

/** 清理崩溃残留的 .config.json.tmp-*（写完 tmp、rename 前进程死掉就永远留一个） */
function sweepConfigTmp(dir: string): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('.config.json.tmp-')) continue;
      const file = path.join(dir, name);
      try {
        // 只按年龄清：1 小时内的可能是并发会话刚写的（锁本应串行化，这里再兜一层）
        if (Date.now() - fs.statSync(file).mtimeMs > 3_600_000) fs.rmSync(file, { force: true });
      } catch {
        // 竞态消失即达成目的
      }
    }
  } catch {
    // 列不出目录就算了
  }
}

export function saveConfig(config: SdkvmConfig): void {
  ensureLayout();
  const file = paths.config();
  sweepConfigTmp(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.config.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * 在全局锁内读-改-写 config，避免 mirror/nrm/mrm 并发丢更新。
 * 可重入：lock.ts 的 heldDepth 计数使 withLock 回调里再调用也不会自锁死。
 */
export function updateConfig(mutator: (config: SdkvmConfig) => void): SdkvmConfig {
  acquireLock();
  try {
    const config = loadConfig();
    mutator(config);
    saveConfig(config);
    return config;
  } finally {
    // 保存已成功：释放失败（Windows 杀软短暂锁目录）不应把成功操作报成失败
    try {
      releaseLock();
    } catch (err) {
      log.warn(`failed to release the sdkvm lock: ${(err as Error).message}`);
    }
  }
}
