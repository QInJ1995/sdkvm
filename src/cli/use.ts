import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { detectPlatform, type Platform } from '../core/platform.js';
import { envGet } from '../core/env.js';
import { withLock } from '../core/lock.js';
import { findInstalled } from '../core/registry.js';
import { setCurrent } from '../fs/link.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { detectRcFile } from '../shell/detect.js';
import { rcBegin, rcBlock, rcBlockFish, upsertRcFile } from '../shell/rc.js';
import { ensureUserPathWin, setSdkEnvWin, sdkPathEntries } from '../shell/winenv.js';
import { log } from '../ui/log.js';
import { CLI_BIN } from './cmdname.js';

const execFileAsync = promisify(execFile);

/** fish 的 $SHELL 以 /fish 结尾（含 /usr/bin/fish） */
function isFishShell(): boolean {
  return /(^|\/)fish$/.test(process.env.SHELL ?? '');
}

/** rc 已写入 java 标记块时，JAVA_HOME 会在新 shell 里生效，无需再提示装 JDK */
function rcExportsJava(platform: Platform, rc: string | null): boolean {
  if (platform.os === 'windows' || !rc) return false;
  try {
    return fs.readFileSync(rc, 'utf8').includes(rcBegin('java'));
  } catch {
    return false;
  }
}

async function showSdkVersion(binPath: string, type: SdkTypeId): Promise<void> {
  const spec = getSdkType(type);
  try {
    const { stdout, stderr } = await execFileAsync(binPath, spec.versionCheck.args, {
      timeout: 30_000,
    });
    const text = (spec.versionCheck.stream === 'stdout' ? stdout : stderr) || '';
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const line = lines.find((l) => /version/i.test(l)) ?? lines[0];
    if (line) log.info(line);
  } catch {
    // 展示失败不影响切换结果
  }
}

export async function useCommand(
  type: SdkTypeId,
  specInput: string,
  opts: { vendor?: string },
): Promise<void> {
  const platform: Platform = detectPlatform();
  const spec = getSdkType(type);

  let rc: string | null = null;
  let label = '';
  let home = '';
  await withLock(async () => {
    // 查找放进锁内：避免锁外 findInstalled 之后被并发卸载，current 指向已删除目录
    const installed = findInstalled(type, specInput, opts.vendor);
    label = `${installed.version.vendor}-${spec.formatVersion(installed.version)}`;
    home = installed.home;
    setCurrent(type, installed.home, platform);
    // rc / 注册表和 current 链接放在同一把锁里，避免两次 use 互相覆盖标记块
    if (platform.os === 'windows') {
      await setSdkEnvWin(type);
      for (const entry of sdkPathEntries(type)) {
        await ensureUserPathWin(entry);
      }
    } else {
      rc = detectRcFile(platform.os);
      if (rc) upsertRcFile(rc, type);
    }
  });
  log.ok(`current → ${label}`);

  if (platform.os === 'windows') {
    log.info(`${spec.envVar} and PATH updated in user environment`);
    log.warn('reopen your terminal (or restart your IDE) for the change to take effect');
    // 用户 PATH 排在系统 PATH 之后：系统级同名工具会遮蔽 sdkvm 的切换
    log.warn(`if a system-wide ${spec.label} is on the system PATH, it wins — move ${spec.envVar} entries ahead of it or remove the system entry`);
  } else if (rc) {
    log.info(`updated ${rc} — run: source ${rc} (or open a new terminal)`);
  } else {
    log.warn('could not detect your shell; add this to your rc file manually:');
    // rcBlock 是 POSIX 语法，对 fish 不合法
    console.log(isFishShell() ? rcBlockFish(type) : rcBlock(type));
  }
  if (spec.requiresJdk && !envGet('JAVA_HOME') && !rcExportsJava(platform, rc)) {
    log.warn(`${spec.label} needs a JDK. Run: ${CLI_BIN} java use <version>`);
  }
  await showSdkVersion(path.join(home, spec.binRelPath(platform)), type);
}
