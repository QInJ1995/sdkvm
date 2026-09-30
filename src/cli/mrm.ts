import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpFetch } from '../net/http.js';
import { loadConfig, updateConfig } from '../core/config.js';
import { acquireLock, releaseLock } from '../core/lock.js';
import { envGet } from '../core/env.js';
import { SdkvmError } from '../util/errors.js';
import { log } from '../ui/log.js';
import { LIST_NAME_RE, formatListLine, normalizeRegistryUrl } from '../ui/listformat.js';

export interface MavenRegistryEntry {
  /** 列表展示名 */
  name: string;
  url: string;
  /** use 可用、ls 不单独占一行 */
  aliases?: readonly string[];
  list: boolean;
  custom?: boolean;
}

/**
 * 依赖仓库镜像，与 `sdkvm maven mirror`（安装包）无关。
 * `official` 表示删掉 sdkvm 标记块，不写入指向 Central 的 mirror。
 * aliyun 用聚合仓 public，不是安装包用的 repository/central。
 */
export const MAVEN_REGISTRY_PRESETS: readonly MavenRegistryEntry[] = [
  { name: 'official', url: 'https://repo.maven.apache.org/maven2/', list: true },
  {
    name: 'aliyun',
    url: 'https://maven.aliyun.com/repository/public/',
    aliases: ['ali'],
    list: true,
  },
  { name: 'huawei', url: 'https://repo.huaweicloud.com/repository/maven/', list: true },
  {
    name: 'tencent',
    url: 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/',
    list: true,
  },
];

const TEST_TIMEOUT_MS = 5_000;
const PROBE_POM = 'org/apache/maven/maven-artifact/3.9.9/maven-artifact-3.9.9.pom';

export const MRM_BEGIN = '<!-- >>> sdkvm mrm >>> -->';
export const MRM_END = '<!-- <<< sdkvm mrm <<< -->';

const SOURCE_LABEL = {
  flag: '--settings',
  env: 'SDKVM_M2_SETTINGS',
  config: 'config.mavenSettings',
  default: 'default',
} as const;

export type SettingsSource = keyof typeof SOURCE_LABEL;

export interface SettingsTarget {
  file: string;
  source: SettingsSource;
}

export type MavenRepoProbe = (url: string) => Promise<number>;

export { normalizeRegistryUrl };

export function defaultMavenSettingsPath(): string {
  return path.join(os.homedir(), '.m2', 'settings.xml');
}

/** `~` 展开后相对 cwd 解析为绝对路径。 */
export function expandSettingsPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new SdkvmError('settings path is empty');
  }
  let expanded = trimmed;
  if (expanded === '~') expanded = os.homedir();
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(expanded);
}

/**
 * `--settings` > `SDKVM_M2_SETTINGS` > `config.mavenSettings` > `~/.m2/settings.xml`。
 * 前两项不写入配置。
 */
export function resolveSettingsTarget(flag?: string): SettingsTarget {
  if (flag?.trim()) return { file: expandSettingsPath(flag), source: 'flag' };
  const env = envGet('SDKVM_M2_SETTINGS');
  if (env) return { file: expandSettingsPath(env), source: 'env' };
  const configured = loadConfig().mavenSettings.trim();
  if (configured) return { file: expandSettingsPath(configured), source: 'config' };
  return { file: defaultMavenSettingsPath(), source: 'default' };
}

export function isBuiltinMavenRegistryName(name: string): boolean {
  const key = name.trim().toLowerCase();
  return MAVEN_REGISTRY_PRESETS.some(
    (p) => p.name.toLowerCase() === key || p.aliases?.some((a) => a.toLowerCase() === key),
  );
}

export function listMavenRegistries(): MavenRegistryEntry[] {
  const custom = loadConfig().mavenRegistries;
  const out: MavenRegistryEntry[] = [...MAVEN_REGISTRY_PRESETS];
  for (const [name, url] of Object.entries(custom)) {
    out.push({ name, url, list: true, custom: true });
  }
  return out;
}

export function findMavenRegistry(name: string): MavenRegistryEntry | undefined {
  const key = name.trim().toLowerCase();
  return listMavenRegistries().find(
    (p) => p.name.toLowerCase() === key || p.aliases?.some((a) => a.toLowerCase() === key),
  );
}

/** 标记块里的 URL 命中可展示源；没有标记块时由调用方视为 official。 */
export function matchListedMavenRegistry(registryUrl: string): string | null {
  const norm = normalizeRegistryUrl(registryUrl);
  const hit = listMavenRegistries().find(
    (p) => p.list && p.name !== 'official' && normalizeRegistryUrl(p.url) === norm,
  );
  return hit?.name ?? null;
}

export function formatMrmListLine(name: string, url: string, current: boolean): string {
  return formatListLine(name, url, current);
}

/** 标记必须独占一行（允许首尾空白）才算 sdkvm 块边界：
 * 用户 XML 里行中出现的相同注释文本不是边界，按子串计数会误报"不配对"。
 * renderBlock 生成的标记始终独占一行，新旧版本写的块都能识别。 */
function countMarkerLines(content: string, marker: string): number {
  return content.split('\n').filter((l) => l.trim() === marker).length;
}

function assertMarkers(content: string): void {
  const lines = content.split('\n');
  const firstBegin = lines.findIndex((l) => l.trim() === MRM_BEGIN);
  const firstEnd = lines.findIndex((l) => l.trim() === MRM_END);
  const begin = countMarkerLines(content, MRM_BEGIN);
  const end = countMarkerLines(content, MRM_END);
  // END 在 BEGIN 之前也算不配对：stripBlock 从 BEGIN 删到文件尾，会把 END 之后的
  // 用户配置整段吞掉，settings.xml 变成非法 XML 还退出码 0
  if (begin !== end || begin > 1 || (begin === 1 && firstBegin > firstEnd)) {
    throw new SdkvmError('settings.xml has an unpaired sdkvm mrm marker', {
      hint: 'Remove the leftover <!-- >>> sdkvm mrm >>> --> comments by hand, then retry.',
    });
  }
}

function stripBlock(content: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of content.split('\n')) {
    if (!skipping && line.trim() === MRM_BEGIN) {
      skipping = true;
      continue;
    }
    if (skipping && line.trim() === MRM_END) {
      skipping = false;
      continue;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n');
}

function renderBlock(name: string, url: string): string {
  return [
    MRM_BEGIN,
    '<mirror>',
    '  <id>sdkvm</id>',
    '  <mirrorOf>*</mirrorOf>',
    `  <name>${name}</name>`,
    `  <url>${url}</url>`,
    '</mirror>',
    MRM_END,
  ].join('\n');
}

function ensureTrailingNewline(content: string): string {
  if (!content) return '';
  return content.endsWith('\n') ? content : `${content}\n`;
}

interface XmlTag {
  /** `<` 的下标 */
  start: number;
  /** `>` 后一位 */
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

function skipUntil(content: string, from: number, marker: string): number {
  const at = content.indexOf(marker, from);
  return at === -1 ? content.length : at + marker.length;
}

/** 读一个标签。属性引号里的 `>` 不算结束。读不到 `>` 时返回 null。 */
function readTag(content: string, lt: number): XmlTag | null {
  let i = lt + 1;
  let closing = false;
  if (content[i] === '/') {
    closing = true;
    i += 1;
  }
  const nameStart = i;
  while (i < content.length && /[A-Za-z0-9_:-]/.test(content[i] ?? '')) i += 1;
  if (i === nameStart) return null;
  const name = content.slice(nameStart, i);
  let quote: '"' | "'" | null = null;
  let selfClosing = false;
  for (; i < content.length; i += 1) {
    const ch = content[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '/') {
      selfClosing = true;
      continue;
    }
    if (ch === '>') {
      return { start: lt, end: i + 1, name, closing, selfClosing: selfClosing && !closing };
    }
  }
  return null;
}

/**
 * 跳过注释、CDATA、处理指令后再找标签。
 * Maven 发行版自带的 settings.xml 把示例 `<mirrors>` 放在注释里，不能当成真标签。
 */
function findTag(content: string, name: string, closing: boolean): XmlTag | null {
  const want = name.toLowerCase();
  let i = 0;
  while (i < content.length) {
    if (content.startsWith('<!--', i)) {
      i = skipUntil(content, i + 4, '-->');
      continue;
    }
    if (content.startsWith('<![CDATA[', i)) {
      i = skipUntil(content, i + 9, ']]>');
      continue;
    }
    if (content.startsWith('<?', i)) {
      i = skipUntil(content, i + 2, '?>');
      continue;
    }
    if (content.startsWith('<!', i)) {
      i = skipUntil(content, i + 2, '>');
      continue;
    }
    if (content[i] !== '<') {
      i += 1;
      continue;
    }
    const tag = readTag(content, i);
    if (!tag) {
      i += 1;
      continue;
    }
    if (tag.closing === closing && tag.name.toLowerCase() === want) return tag;
    i = tag.end;
  }
  return null;
}

function insertBlock(content: string, block: string): string {
  const mirrors = findTag(content, 'mirrors', false);
  if (mirrors?.selfClosing) {
    const raw = content.slice(mirrors.start, mirrors.end);
    const open = `${raw.slice(0, -1).replace(/\/\s*$/, '').replace(/\s+$/, '')}>`;
    const replacement = `${open}\n${block}\n</${mirrors.name}>`;
    return content.slice(0, mirrors.start) + replacement + content.slice(mirrors.end);
  }
  if (mirrors) {
    return `${content.slice(0, mirrors.end)}\n${block}${content.slice(mirrors.end)}`;
  }
  const close = findTag(content, 'settings', true);
  if (!close) return content;
  const wrapped = `<mirrors>\n${block}\n</mirrors>\n`;
  return content.slice(0, close.start) + wrapped + content.slice(close.start);
}

function minimalSettings(block: string): string {
  return `<settings>\n  <mirrors>\n${block}\n  </mirrors>\n</settings>\n`;
}

/**
 * `mirror === null` 只删除标记块。空文件且要写入时生成最小 settings。
 * 已有 `<mirrors>` 时插到第一个子节点；没有则在 `</settings>` 前补一整段。
 */
export function applyMrmBlock(content: string, mirror: { name: string; url: string } | null): string {
  // 行尾统一按 LF 处理（原有行的 \r 会残留成 \r\r\n），原文件的 CRLF 风格由
  // writeSettings 在写回时整体恢复
  const text = content.replace(/\r\n/g, '\n');
  if (!text.trim()) {
    return mirror ? minimalSettings(renderBlock(mirror.name, mirror.url)) : '';
  }
  assertMarkers(text);
  if (!findTag(text, 'settings', true)) {
    throw new SdkvmError('settings.xml has no </settings>', {
      hint:
        'Fix the file, or point sdkvm mrm at another settings.xml. ' +
        '(A namespace-prefixed root like <mvn:settings> is valid for Maven but not understood here — remove the prefix or manage that file by hand.)',
    });
  }
  const hadBlock = countMarkerLines(text, MRM_BEGIN) > 0;
  const stripped = stripBlock(text);
  if (!mirror) return hadBlock ? ensureTrailingNewline(stripped) : content;
  return ensureTrailingNewline(insertBlock(stripped, renderBlock(mirror.name, mirror.url)));
}

export function readMrmUrl(content: string): string | null {
  if (!content.trim()) return null;
  assertMarkers(content);
  const lines = content.split('\n');
  const beginIdx = lines.findIndex((l) => l.trim() === MRM_BEGIN);
  if (beginIdx < 0) return null;
  const endIdx = lines.findIndex((l, i) => i > beginIdx && l.trim() === MRM_END);
  if (endIdx < 0) return null; // assertMarkers 已保证配对，这里防御
  const body = lines.slice(beginIdx + 1, endIdx).join('\n');
  const url = /<url>\s*([^<\s]+)\s*<\/url>/.exec(body)?.[1];
  if (!url) {
    throw new SdkvmError('sdkvm mrm block has no <url>', {
      hint: 'Remove the sdkvm mrm marker block, then run sdkvm mrm use again.',
    });
  }
  return url;
}

function settingsLine(target: SettingsTarget): string {
  return `settings ${target.file} (${SOURCE_LABEL[target.source]})`;
}

function readFileIfExists(file: string): string {
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    throw new SdkvmError(`${file} is a directory`, {
      hint: 'Pass a settings.xml file path.',
    });
  }
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function writeSettings(file: string, content: string): void {
  // settings.xml 常被 chezmoi/stow 等做成符号链接：tmp+rename 会把链接本身换成普通
  // 文件，脱离用户的 dotfile 管理。写透到链接目标（读侧本来就跟随符号链接）。
  // 悬空链接 realpathSync 读不出目标会抛错——被吞掉后 tmp+rename 会把链接本身
  // 换成普通文件，用户 stow 回来就断了；readlink 逐层解析拼写，仍解析不出才按原路径写
  try {
    let cur = file;
    for (let hops = 0; hops < 8; hops++) {
      // 解析出的目标不存在（悬空链接）不是错误：在解析出的路径上创建文件，
      // 循环条件里直接 lstat 抛 ENOENT 会被外层 catch 吞掉已解析结果、退回
      // 链接路径写，rename 照样把链接顶掉
      let st: fs.Stats;
      try {
        st = fs.lstatSync(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw err;
      }
      if (!st.isSymbolicLink()) break;
      cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
    }
    file = cur;
  } catch {
    // 目标读不出（权限等）：按原路径写
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 写回要保留的两个原文件属性（都在存在时才读得到）
  let mode: number | undefined;
  let hadCrlf = false;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    // 非 UTF-8 的 settings.xml（GBK 注释等）：utf8 解码再写回会把原始字节换成替换字符，
    // 且不可逆。写回前先备份原文件（与 rc 文件同款保护）
    if (!Buffer.from(raw.toString('utf8'), 'utf8').equals(raw)) {
      const bak = `${file}.sdkvm-bak`;
      fs.copyFileSync(file, bak);
      log.warn(`${file} is not valid UTF-8; original backed up to ${bak}`);
    }
    // 行尾按多数派保留（rc.ts 同款）：混合行尾按"出现过 CRLF"整体翻 CRLF 会让
    // LF 为主的行全部漂移
    const text = raw.toString('utf8');
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
    hadCrlf = crlf > lf;
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      // 读不到权限就按默认创建
    }
  }
  // 原文件是 CRLF 就整体按 CRLF 写回：applyMrmBlock 内部按 LF 处理，
  // 不恢复的话整个文件的行尾风格会漂移（git diff 全文件变化）
  const withNewline = ensureTrailingNewline(content);
  const out = hadCrlf && !withNewline.includes('\r\n') ? withNewline.replace(/(?<!\r)\n/g, '\r\n') : withNewline;
  const tmp = `${file}.tmp-${process.pid}`;
  // 权限跟随原文件：settings.xml 可能是 0600 的私有文件，tmp+rename 默认 0644
  // 会把内容暴露给同机其它用户
  fs.writeFileSync(tmp, out, mode !== undefined ? { mode } : {});
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function officialUrl(): string {
  return MAVEN_REGISTRY_PRESETS[0]?.url ?? 'https://repo.maven.apache.org/maven2/';
}

function activeMirror(file: string): { name: string; url: string } {
  const content = readFileIfExists(file);
  const url = readMrmUrl(content);
  if (!url) return { name: 'official', url: officialUrl() };
  return { name: matchListedMavenRegistry(url) ?? 'custom', url };
}

function assertRepoUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (/[<>&]/.test(trimmed)) {
    throw new SdkvmError('Repository URL cannot contain <, >, or &', {
      hint: 'Those characters would break settings.xml. Use a plain http(s) repository URL.',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SdkvmError(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SdkvmError(`Invalid URL protocol: ${parsed.protocol}`, {
      hint: 'Expected http:// or https://',
    });
  }
  if (parsed.username || parsed.password) {
    throw new SdkvmError('Repository URL cannot include a username or password', {
      hint: 'Maven credentials belong in <servers>, not in the mirror URL.',
    });
  }
  // query / fragment 进 <url> 不会被 Maven 当镜像参数用，只会得到一个拉不到东西的
  // 坏地址；结尾裸 `?`/`#` 在 URL 对象里 search/hash 是空串，判空拦不住，须查原文
  if (/[?#]/.test(trimmed)) {
    throw new SdkvmError('Repository URL cannot include a query string or fragment', {
      hint: 'Use a plain http(s) repository URL.',
    });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/';
  return parsed;
}

function unknownRegistry(name: string): SdkvmError {
  const names = listMavenRegistries()
    .flatMap((p) => [p.name, ...(p.aliases ?? [])])
    .join(', ');
  return new SdkvmError(`Unknown Maven registry "${name}"`, {
    hint: `Available: ${names}`,
  });
}

export function mrmLs(opts: { settings?: string } = {}): void {
  const target = resolveSettingsTarget(opts.settings);
  const active = activeMirror(target.file);
  log.info(settingsLine(target));
  for (const p of listMavenRegistries()) {
    if (!p.list) continue;
    log.raw(formatMrmListLine(p.name, p.url, active.name === p.name));
  }
  if (active.name === 'custom') {
    log.raw(formatMrmListLine('custom', active.url, true));
  }
}

export function mrmCurrent(opts: { settings?: string } = {}): void {
  const target = resolveSettingsTarget(opts.settings);
  const active = activeMirror(target.file);
  log.info(settingsLine(target));
  log.raw(`${active.name} → ${active.url}`);
}

export function mrmUse(name: string, opts: { settings?: string } = {}): void {
  const entry = findMavenRegistry(name);
  if (!entry) throw unknownRegistry(name);
  const target = resolveSettingsTarget(opts.settings);
  // settings.xml 读-改-写与 config 一样要进锁，避免并发 mrm use 互相覆盖
  acquireLock();
  let existing = '';
  let next = '';
  try {
    existing = readFileIfExists(target.file);
    next =
      entry.name === 'official'
        ? applyMrmBlock(existing, null)
        : applyMrmBlock(existing, { name: entry.name, url: entry.url });
    if (next !== existing) writeSettings(target.file, next);
  } finally {
    releaseLock();
  }
  if (entry.name === 'official') {
    log.ok('maven mirror → official (Central, no sdkvm mirror)');
  } else {
    log.ok(`maven mirror → ${entry.name} (${entry.url})`);
  }
  log.info(settingsLine(target));
  if (path.normalize(target.file) !== path.normalize(defaultMavenSettingsPath())) {
    log.info(`Maven reads ~/.m2/settings.xml unless you pass: mvn -s ${target.file}`);
  }
}

export function mrmAdd(name: string, url: string): void {
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
  if (isBuiltinMavenRegistryName(key)) {
    throw new SdkvmError(`Cannot overwrite built-in registry "${key}"`, {
      hint: `Pick another name, or use: sdkvm mrm use ${key}`,
    });
  }
  const normalized = assertRepoUrl(url).href;
  updateConfig((config) => {
    const existingKey = Object.keys(config.mavenRegistries).find((k) => k.toLowerCase() === key.toLowerCase());
    if (existingKey && existingKey !== key) delete config.mavenRegistries[existingKey];
    config.mavenRegistries[key] = normalized;
  });
  log.ok(`added Maven registry ${key} → ${normalized}`);
}

export function mrmDel(name: string, opts: { settings?: string } = {}): void {
  const key = name.trim();
  if (isBuiltinMavenRegistryName(key)) {
    throw new SdkvmError(`Cannot delete built-in registry "${key}"`);
  }
  let deleted: string | undefined;
  let deletedUrl: string | undefined;
  updateConfig((config) => {
    const existing = Object.keys(config.mavenRegistries).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!existing) {
      throw new SdkvmError(`Unknown custom registry "${name}"`, {
        hint: 'Only registries added with sdkvm mrm add can be deleted',
      });
    }
    deletedUrl = config.mavenRegistries[existing];
    delete config.mavenRegistries[existing];
    deleted = existing;
  });
  // 删的恰是 settings.xml 里"当前生效"的镜像时，sdkvm 块会悬空指向已删地址：
  // 移除标记块回到官方源（等价 use official）。
  // "是否生效"的判定必须在锁内复核：锁外先读再进锁的话，中间并发的 mrm use
  // 换了镜像，我们会把别人刚写的新块误删
  const target = resolveSettingsTarget(opts.settings);
  if (deletedUrl) {
    acquireLock();
    let removedBlock = false;
    try {
      const existing = readFileIfExists(target.file);
      const activeUrl = readMrmUrl(existing);
      if (activeUrl && normalizeRegistryUrl(activeUrl) === normalizeRegistryUrl(deletedUrl)) {
        const next = applyMrmBlock(existing, null);
        if (next !== existing) {
          writeSettings(target.file, next);
          removedBlock = true;
        }
      }
    } finally {
      releaseLock();
    }
    if (removedBlock) {
      log.warn(`"${deleted}" was the active mirror; removed the sdkvm block (back to official)`);
    }
  }
  log.ok(`deleted Maven registry ${deleted}`);
}

/** GET 一个已知 POM。5xx、4xx 或网络错误记为 Fetch Error，命令本身仍成功。 */
export async function defaultMavenRepoProbe(url: string): Promise<number> {
  // 经 URL 对象拼路径：字符串拼接会把 POM 路径加到 query 之后
  const target = new URL(url);
  target.pathname = target.pathname.replace(/\/+$/, '') + '/' + PROBE_POM;
  const started = Date.now();
  // 走 httpFetch：与下载同一代理通道（HTTPS_PROXY）与重试策略
  const res = await httpFetch(target.href, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.body?.cancel()?.catch(() => undefined);
  return Date.now() - started;
}

export async function mrmTest(
  name: string | undefined,
  opts: { settings?: string; probe?: MavenRepoProbe } = {},
): Promise<void> {
  const probe = opts.probe ?? defaultMavenRepoProbe;
  const target = resolveSettingsTarget(opts.settings);
  const active = activeMirror(target.file);
  let targets = listMavenRegistries().filter((p) => p.list);
  if (name) {
    const entry = findMavenRegistry(name);
    if (!entry) throw unknownRegistry(name);
    targets = [{ ...entry, list: true }];
  }
  // 并行探测；全部失败时置非零退出码（与 `ls -r` 全厂商失败一致），CI 靠退出码感知
  let failures = 0;
  const lines = await Promise.all(
    targets.map(async (p) => {
      const isCurrent = active.name === p.name || normalizeRegistryUrl(p.url) === normalizeRegistryUrl(active.url);
      try {
        const ms = await probe(p.url);
        return formatMrmListLine(p.name, `${ms} ms`, isCurrent);
      } catch (err) {
        failures++;
        const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return formatMrmListLine(p.name, `Fetch Error (${detail})`, isCurrent);
      }
    }),
  );
  for (const line of lines) log.raw(line);
  if (failures === targets.length && targets.length > 0) process.exitCode = 1;
}

export function mrmSettings(arg: string | undefined, opts: { settings?: string } = {}): void {
  if (arg === undefined) {
    log.info(settingsLine(resolveSettingsTarget(opts.settings)));
    return;
  }
  if (arg === 'unset') {
    updateConfig((config) => {
      config.mavenSettings = '';
    });
    log.ok('cleared config.mavenSettings');
    const target = resolveSettingsTarget(opts.settings);
    if (target.source !== 'default') log.info(settingsLine(target));
    return;
  }
  const abs = expandSettingsPath(arg);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    throw new SdkvmError(`${abs} is a directory`, {
      hint: 'Pass a settings.xml file path.',
    });
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  updateConfig((config) => {
    config.mavenSettings = abs;
  });
  log.ok(`maven settings → ${abs}`);
}
