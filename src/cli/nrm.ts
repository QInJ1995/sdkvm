import { loadConfig, updateConfig } from '../core/config.js';
import { npmExec, run } from '../util/spawn.js';
import { SdkvmError } from '../util/errors.js';
import { log } from '../ui/log.js';
import { LIST_NAME_RE, formatListLine, normalizeRegistryUrl } from '../ui/listformat.js';

export { normalizeRegistryUrl };

export interface NpmRegistryEntry {
  /** 列表展示名 */
  name: string;
  url: string;
  /** 是否在 ls 中展示（别名可隐藏，仅 use 可用） */
  list: boolean;
  /** 用户自定义源（可 del） */
  custom?: boolean;
}

/** 内置源：与常见 nrm 默认集对齐；npmmirror 为 taobao 别名，不单独占一行 */
export const NPM_REGISTRY_PRESETS: readonly NpmRegistryEntry[] = [
  { name: 'npm', url: 'https://registry.npmjs.org/', list: true },
  { name: 'yarn', url: 'https://registry.yarnpkg.com/', list: true },
  { name: 'tencent', url: 'https://mirrors.tencent.com/npm/', list: true },
  { name: 'cnpm', url: 'https://r.cnpmjs.org/', list: true },
  { name: 'taobao', url: 'https://registry.npmmirror.com/', list: true },
  { name: 'npmmirror', url: 'https://registry.npmmirror.com/', list: false },
  { name: 'npmMirror', url: 'https://skimdb.npmjs.com/registry/', list: true },
  { name: 'huawei', url: 'https://repo.huaweicloud.com/repository/npm/', list: true },
];

const TEST_TIMEOUT_MS = 5_000;

export function isBuiltinRegistryName(name: string): boolean {
  const key = name.trim().toLowerCase();
  return NPM_REGISTRY_PRESETS.some((p) => p.name.toLowerCase() === key);
}

/** 内置 + 用户自定义（自定义覆盖同名展示，但禁止覆盖内置名） */
export function listRegistryEntries(): NpmRegistryEntry[] {
  const custom = loadConfig().npmRegistries;
  const out: NpmRegistryEntry[] = [...NPM_REGISTRY_PRESETS];
  for (const [name, url] of Object.entries(custom)) {
    out.push({ name, url, list: true, custom: true });
  }
  return out;
}

export function findRegistryByName(name: string): NpmRegistryEntry | undefined {
  const key = name.trim();
  const all = listRegistryEntries();
  return all.find((p) => p.name === key || p.name.toLowerCase() === key.toLowerCase());
}

/** 规范化 URL 命中的第一个可展示名（含自定义） */
export function matchListedRegistryName(registryUrl: string): string | null {
  const norm = normalizeRegistryUrl(registryUrl);
  const hit = listRegistryEntries().find((p) => p.list && normalizeRegistryUrl(p.url) === norm);
  return hit?.name ?? null;
}

export function formatNrmListLine(name: string, url: string, current: boolean): string {
  return formatListLine(name, url, current);
}

export type NpmRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
export type RegistryProbe = (url: string) => Promise<number>;

async function defaultNpmRunner(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { cmd, prefixArgs } = npmExec();
    return await run(cmd, [...prefixArgs, ...args]);
  } catch (err) {
    if (err instanceof SdkvmError && /npm is not available/.test(err.message)) {
      throw err; // npmExec 已给出安装引导提示
    }
    if (err instanceof SdkvmError) {
      // 调用层面的失败（如找不到可执行文件）统一给安装引导提示
      throw new SdkvmError('npm is not available', {
        hint: `Check your Node.js/npm installation. Detail: ${err.message}`,
      });
    }
    throw err;
  }
}

/** HEAD 探测 registry；失败抛错，成功返回耗时毫秒 */
export async function defaultRegistryProbe(url: string): Promise<number> {
  const target = url.replace(/\/+$/, '') + '/';
  const started = Date.now();
  const res = await fetch(target, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  // 部分 registry 对 HEAD 返回 404/405，只要能连上就算通
  if (res.status >= 500) {
    throw new Error(`HTTP ${res.status}`);
  }
  return Date.now() - started;
}

export async function getNpmRegistry(npmRun: NpmRunner = defaultNpmRunner): Promise<string> {
  const { stdout } = await npmRun(['config', 'get', 'registry']);
  const url = stdout.trim();
  if (!url || url === 'undefined') {
    throw new SdkvmError('npm config get registry returned empty', {
      hint: 'Check your npm installation: npm config get registry',
    });
  }
  return url;
}

export async function setNpmRegistry(url: string, npmRun: NpmRunner = defaultNpmRunner): Promise<void> {
  await npmRun(['config', 'set', 'registry', url, '--location=user']);
}

export async function nrmLs(npmRun: NpmRunner = defaultNpmRunner): Promise<void> {
  const current = await getNpmRegistry(npmRun);
  const matched = matchListedRegistryName(current);
  for (const p of listRegistryEntries()) {
    if (!p.list) continue;
    log.raw(formatNrmListLine(p.name, p.url, matched === p.name));
  }
  if (!matched) {
    log.raw(formatNrmListLine('custom', current, true));
  }
}

export async function nrmCurrent(npmRun: NpmRunner = defaultNpmRunner): Promise<void> {
  const current = await getNpmRegistry(npmRun);
  const matched = matchListedRegistryName(current);
  if (matched) {
    log.raw(`${matched} → ${current}`);
  } else {
    log.raw(`custom → ${current}`);
  }
}

export async function nrmUse(name: string, npmRun: NpmRunner = defaultNpmRunner): Promise<void> {
  const entry = findRegistryByName(name);
  if (!entry) {
    const names = listRegistryEntries()
      .map((p) => p.name)
      .join(', ');
    throw new SdkvmError(`Unknown registry "${name}"`, {
      hint: `Available: ${names}`,
    });
  }
  await setNpmRegistry(entry.url, npmRun);
  log.ok(`npm registry → ${entry.name} (${entry.url})`);
}

export function nrmAdd(name: string, url: string): void {
  const key = name.trim();
  if (!LIST_NAME_RE.test(key)) {
    throw new SdkvmError(`Invalid registry name "${name}"`, {
      hint: 'Use letters, digits, _ or -; must start with a letter',
    });
  }
  if (isBuiltinRegistryName(key)) {
    throw new SdkvmError(`Cannot overwrite built-in registry "${key}"`, {
      hint: 'Pick another name, or use: sdkvm nrm use ' + key,
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new SdkvmError(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SdkvmError(`Invalid URL protocol: ${parsed.protocol}`, {
      hint: 'Expected http:// or https://',
    });
  }
  // 只规范化 pathname 尾斜杠，保留 query/hash
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/';
  const normalized = parsed.href;
  updateConfig((config) => {
    const existingKey = Object.keys(config.npmRegistries).find(
      (k) => k.toLowerCase() === key.toLowerCase(),
    );
    if (existingKey && existingKey !== key) {
      delete config.npmRegistries[existingKey];
    }
    config.npmRegistries[key] = normalized;
  });
  log.ok(`added registry ${key} → ${normalized}`);
}

export function nrmDel(name: string): void {
  const key = name.trim();
  if (isBuiltinRegistryName(key)) {
    throw new SdkvmError(`Cannot delete built-in registry "${key}"`);
  }
  let deleted: string | undefined;
  updateConfig((config) => {
    const existing = Object.keys(config.npmRegistries).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!existing) {
      throw new SdkvmError(`Unknown custom registry "${name}"`, {
        hint: 'Only registries added with sdkvm nrm add can be deleted',
      });
    }
    delete config.npmRegistries[existing];
    deleted = existing;
  });
  log.ok(`deleted registry ${deleted}`);
}

export async function nrmTest(
  name: string | undefined,
  opts: { npmRun?: NpmRunner; probe?: RegistryProbe } = {},
): Promise<void> {
  const npmRun = opts.npmRun ?? defaultNpmRunner;
  const probe = opts.probe ?? defaultRegistryProbe;
  const current = await getNpmRegistry(npmRun);
  const matched = matchListedRegistryName(current);

  let targets = listRegistryEntries().filter((p) => p.list);
  if (name) {
    const entry = findRegistryByName(name);
    if (!entry) {
      throw new SdkvmError(`Unknown registry "${name}"`, {
        hint: 'Run: sdkvm nrm ls',
      });
    }
    targets = [{ ...entry, list: true }];
  }

  for (const p of targets) {
    const isCurrent = matched === p.name || normalizeRegistryUrl(p.url) === normalizeRegistryUrl(current);
    try {
      const ms = await probe(p.url);
      log.raw(formatNrmListLine(p.name, `${ms} ms`, isCurrent));
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      log.raw(formatNrmListLine(p.name, `Fetch Error (${detail})`, isCurrent));
    }
  }
}
