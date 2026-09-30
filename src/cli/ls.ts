import { currentSdk, listInstalled } from '../core/registry.js';
import { readCurrent } from '../fs/link.js';
import { getSdkType } from '../sdk/index.js';
import { SDK_TYPES } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { getVendor, allVendorIds, resolveVendorId } from '../vendor/index.js';
import { loadConfig } from '../core/config.js';
import { toSdkvmError } from '../util/errors.js';
import { log } from '../ui/log.js';
import { cmdPath } from './cmdname.js';

export async function lsCommand(
  type: SdkTypeId,
  opts: { remote?: boolean; vendor?: string },
): Promise<void> {
  if (opts.remote) return listRemote(type, opts);
  listLocal(type);
}

function listLocal(type: SdkTypeId): void {
  const spec = getSdkType(type);
  const installed = listInstalled(type);
  if (installed.length === 0) {
    log.info(`no ${spec.label} installed`);
    log.info(`try: ${cmdPath(type)} install ${spec.supportsLts ? 'lts' : 'latest'}`);
    return;
  }
  const current = currentSdk(type);
  for (const j of installed) {
    const name = `${j.version.vendor}-${spec.formatVersion(j.version)}`;
    const marker = current?.dirPath === j.dirPath ? '→' : ' ';
    log.raw(`${marker} ${name}`);
  }
}

/** 远程列表：并行拉取该类型各厂商，展示行即 install 可用的名称（vendor-版本线） */
async function listRemote(type: SdkTypeId, opts: { vendor?: string }): Promise<void> {
  const config = loadConfig();
  const ids = opts.vendor ? [resolveVendorId(type, opts.vendor, config)] : allVendorIds(type);

  const sections = await Promise.all(
    ids.map(async (id) => {
      const vendor = getVendor(type, id);
      try {
        const lines = (await vendor.listMajors()).slice().sort((a, b) => b.key.localeCompare(a.key, undefined, { numeric: true }));
        return { vendor, lines };
      } catch (err) {
        // 单个厂商失败不拖垮整个列表
        log.warn(`${vendor.label}: list unavailable (${toSdkvmError(err).message})`);
        return null;
      }
    }),
  );
  // 全部厂商都失败时不应表现为成功（单厂商失败已有 warn）
  if (sections.length > 0 && sections.every((sec) => sec === null)) {
    process.exitCode = 1;
  }

  for (const sec of sections) {
    if (!sec) continue;
    const { vendor, lines } = sec;
    log.raw('');
    log.raw(`# ${vendor.label}`);
    if (lines.length === 0) {
      // 整段静默省略会让"列出来了却零行"无法与漏列区分（linux/aarch64 的 Flutter 就是这样）
      log.raw('  # no version lines for this platform');
      continue;
    }
    const width = Math.max(...lines.map((m) => `${vendor.id}-${m.key}`.length)) + 2;
    const MAX_LINES = 12;
    const shown = lines.slice(0, MAX_LINES);
    for (const m of shown) {
      const name = `${vendor.id}-${m.key}`.padEnd(width);
      const lts = m.lts ? '(lts) ' : '';
      const latest = m.latestFullVersion ? `latest: ${vendor.id}-${m.latestFullVersion}` : '';
      log.raw(`  ${name}${lts}${latest}`.trimEnd());
    }
    if (lines.length > shown.length) {
      log.raw(`  # note: ${lines.length - shown.length} older version lines hidden; install older ones by exact name, e.g. ${vendor.id}-${lines[lines.length - 1]?.key}`);
    }
    if (!vendor.supportsFullVersionList) {
      const first = lines[0]?.key ?? '';
      log.raw(`  # note: no version-list API; install resolves to the latest patch, e.g. ${cmdPath(type)} install ${vendor.id}-${first}`);
    }
  }
  log.raw('');
  log.raw(`# install with: ${cmdPath(type)} install <name>`);
}

/** 裸 current：遍历全部已注册 SDK 类型各显示一行 */
export function currentCommand(types: readonly SdkTypeId[] = SDK_TYPES): void {
  let any = false;
  for (const type of types) {
    const spec = getSdkType(type);
    const current = currentSdk(type);
    if (!current) {
      // 链接在、目标不在（安装被手动删除）：静默跳过会被当成"没有 current"，其实需要修复
      const target = readCurrent(type);
      if (target) {
        log.warn(`${type}: current link is broken (points to ${target}, which is not installed)`);
        log.warn(`fix with: ${cmdPath(type)} use <version>`);
      }
      continue;
    }
    any = true;
    log.raw(`${type}: ${current.version.vendor}-${spec.formatVersion(current.version)}`);
    log.raw(`  ${spec.envVar} → ${current.home}`);
  }
  if (!any) {
    log.info('no current SDK');
    log.info(`run: ${cmdPath('java')} use <version>   (see: ${cmdPath('java')} ls)`);
  }
}
