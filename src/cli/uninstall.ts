import fs from 'node:fs';
import { findInstalled, currentSdk } from '../core/registry.js';
import { withLock } from '../core/lock.js';
import { clearCurrent } from '../fs/link.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { detectPlatform } from '../core/platform.js';
import { detectRcFile } from '../shell/detect.js';
import { removeRcBlockFromFile } from '../shell/rc.js';
import { removeFromUserPathWin, removeEnvWin, sdkPathEntries } from '../shell/winenv.js';
import { log } from '../ui/log.js';
import { cmdPath } from './cmdname.js';

export async function uninstallCommand(
  type: SdkTypeId,
  specInput: string,
  opts: { vendor?: string },
): Promise<void> {
  const spec = getSdkType(type);
  const platform = detectPlatform();
  await withLock(async () => {
    // 查找放进锁内（与 useCommand 一致）：避免锁外 find 之后被并发安装/卸载改掉目标
    const installed = findInstalled(type, specInput, opts.vendor);
    // 先判 current 再删目录：删完之后 listInstalled 里已没有它，
    // currentSdk 会把"当前版本"误判成"不是当前"，跳过链接与 rc 清理
    const wasCurrent = currentSdk(type)?.dirPath === installed.dirPath;
    fs.rmSync(installed.dirPath, { recursive: true, force: true });
    if (!wasCurrent) return;
    // 卸载的是当前版本：清掉 current 链接与 rc / 注册表里的环境痕迹，避免悬空的 JAVA_HOME 等
    clearCurrent(type);
    if (platform.os === 'windows') {
      await removeEnvWin(spec.envVar);
      for (const entry of sdkPathEntries(type)) {
        await removeFromUserPathWin(entry);
      }
      log.warn(`removed ${spec.envVar} and its PATH entries (uninstalled the current ${spec.label})`);
    } else {
      const rc = detectRcFile(platform.os);
      if (rc) {
        removeRcBlockFromFile(rc, type);
        log.warn(`removed the ${type} block from ${rc} (uninstalled the current ${spec.label})`);
      } else {
        log.warn(
          `uninstalled the current ${spec.label}; remove ${spec.envVar} from your shell rc manually`,
        );
      }
    }
    log.info(`select another: ${cmdPath(type)} use <version>`);
    log.ok(`removed ${installed.version.vendor}-${spec.formatVersion(installed.version)}`);
  });
}
