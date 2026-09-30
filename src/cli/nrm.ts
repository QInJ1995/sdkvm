import { loadConfig, updateConfig } from '../core/config.js';
import { HttpError, httpFetch } from '../net/http.js';
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

export async function defaultNpmRunner(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { cmd, prefixArgs } = npmExec();
    return await run(cmd, [...prefixArgs, ...args]);
  } catch (err) {
    if (err instanceof SdkvmError && /npm is not available/.test(err.message)) {
      throw err; // npmExec 已给出安装引导提示
    }
    // run() 会把两类失败合流：errno 字符串 code（spawn 不到可执行文件——npm 确实
    // 没装）与数字 code（npm 自身非零退出，如只读 .npmrc、磁盘满）。只有前者该
    // 报"npm is not available"，后者原样上抛——误标会把排障方向带偏
    const cause = (err as { cause?: { code?: unknown } }).cause;
    if (err instanceof SdkvmError && typeof cause?.code !== 'string') throw err;
    if (err instanceof SdkvmError) {
      throw new SdkvmError('npm is not available', {
        hint: `Check your Node.js/npm installation. Detail: ${err.message}`,
      });
    }
    throw err;
  }
}

/** HEAD 探测 registry；失败抛错，成功返回耗时毫秒 */
export async function defaultRegistryProbe(url: string): Promise<number> {
  // 经 URL 对象补尾斜杠：字符串拼接会把 '/' 加到 query 之后（?token=abc/）
  const target = new URL(url);
  if (!target.pathname.endsWith('/')) target.pathname += '/';
  const started = Date.now();
  try {
    // 与下载同一代理通道。4xx（不少源对 HEAD 回 404/405）只要连上就算通。
    const res = await httpFetch(target.href, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    await res.body?.cancel()?.catch(() => undefined);
  } catch (err) {
    if (err instanceof HttpError && err.status > 0 && err.status < 500) return Date.now() - started;
    throw err;
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
  if (key.toLowerCase() === 'custom') {
    // "custom" 是 ls 输出里"未命名自定义 URL"的伪名，占用会造成两行同名条目
    throw new SdkvmError(`"${key}" is a reserved name`, {
      hint: 'Pick another name for your registry.',
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
  if (parsed.username || parsed.password) {
    // 明文进 ~/.npmrc 与终端回显；与 mrm add 的策略一致
    throw new SdkvmError('Registry URL cannot include a username or password', {
      hint: 'Put npm credentials in ~/.npmrc (_auth) or a .yarnrc.yml token, not the URL.',
    });
  }
  if (/[?#]/.test(url.trim())) {
    throw new SdkvmError('Registry URL cannot include a query string or fragment', {
      hint: 'Put npm credentials in ~/.npmrc (_auth), not in the registry URL.',
    });
  }
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

export async function nrmDel(name: string, npmRun: NpmRunner = defaultNpmRunner): Promise<void> {
  const key = name.trim();
  if (isBuiltinRegistryName(key)) {
    throw new SdkvmError(`Cannot delete built-in registry "${key}"`);
  }
  let deleted: string | undefined;
  let deletedUrl: string | undefined;
  updateConfig((config) => {
    const existing = Object.keys(config.npmRegistries).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!existing) {
      throw new SdkvmError(`Unknown custom registry "${name}"`, {
        hint: 'Only registries added with sdkvm nrm add can be deleted',
      });
    }
    deletedUrl = config.npmRegistries[existing];
    delete config.npmRegistries[existing];
    deleted = existing;
  });
  // updateConfig 回调要么抛错要么必然赋值；显式兜底以满足类型收窄
  if (deleted === undefined || deletedUrl === undefined) {
    throw new SdkvmError(`Unknown custom registry "${name}"`);
  }
  // 删的恰是"当前使用中"的 registry 时，.npmrc 会悬空指向已删地址（nrm current 还会误报
  // custom）。回退到官方源，避免后续 npm install 全部打到死地址
  const [officialPreset] = NPM_REGISTRY_PRESETS;
  const official = officialPreset?.url ?? 'https://registry.npmjs.org/';
  try {
    const current = await getNpmRegistry(npmRun);
    if (normalizeRegistryUrl(current) === normalizeRegistryUrl(deletedUrl)) {
      await setNpmRegistry(official, npmRun);
      log.warn(`"${deleted}" was the current registry; reverted to npm (${official})`);
    }
  } catch (err) {
    // npm 不可用：删除本身已完成，仅无法回退当前源
    log.warn(`could not reset the current npm registry: ${(err as Error).message}`);
  }
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

  // 并行探测：串行 8 个源 × 5s 超时最坏要等 40s+
  let failures = 0;
  const lines = await Promise.all(
    targets.map(async (p) => {
      const isCurrent = matched === p.name || normalizeRegistryUrl(p.url) === normalizeRegistryUrl(current);
      try {
        const ms = await probe(p.url);
        return formatNrmListLine(p.name, `${ms} ms`, isCurrent);
      } catch (err) {
        failures++;
        const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return formatNrmListLine(p.name, `Fetch Error (${detail})`, isCurrent);
      }
    }),
  );
  for (const line of lines) log.raw(line);
  // 全部源都失败时不应表现为成功（与 `ls -r` 全厂商失败一致），CI 靠退出码感知
  if (failures === targets.length && targets.length > 0) process.exitCode = 1;
}
