import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPlatform, type Platform } from '../core/platform.js';
import { envGet } from '../core/env.js';
import { withLock } from '../core/lock.js';
import { findInstalled } from '../core/registry.js';
import { setCurrent } from '../fs/link.js';
import { getSdkType } from '../sdk/index.js';
import { recoverInterruptedInstalls } from './install.js';
import type { SdkTypeId } from '../sdk/types.js';
import { detectRcFile } from '../shell/detect.js';
import { rcBegin, rcBlock, rcBlockFish, upsertRcFile } from '../shell/rc.js';
import { ensureUserPathWin, setSdkEnvWin, sdkPathEntries, getEnvWin } from '../shell/winenv.js';
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
  // 对象装箱：闭包内赋值、闭包外读取，裸 let 会被 TS 按初始值收窄成 never
  const envState: { error: Error | null } = { error: null };
  await withLock(async () => {
    // 与 install/uninstall 相同的恢复：上次硬中断留下的 .incomplete 标记会把完好的
    // 安装从 findInstalled 里藏掉（use 报"未安装"直到对该类型跑一次 install/uninstall）
    recoverInterruptedInstalls(type);
    // 查找放进锁内：避免锁外 findInstalled 之后被并发卸载，current 指向已删除目录
    const installed = findInstalled(type, specInput, opts.vendor);
    label = `${installed.version.vendor}-${spec.formatVersion(installed.version)}`;
    home = installed.home;
    setCurrent(type, installed.home, platform);
    // rc / 注册表和 current 链接放在同一把锁里，避免两次 use 互相覆盖标记块。
    // 链接已切换成功后，rc/注册表写失败（只读 rc、注册表被组策略锁住）不应让整个
    // 命令报错——降级为提示手动补写
    if (platform.os === 'windows') {
      try {
        await setSdkEnvWin(type);
        for (const entry of sdkPathEntries(type)) {
          await ensureUserPathWin(entry);
        }
      } catch (err) {
        envState.error = err instanceof Error ? err : new Error(String(err));
      }
    } else {
      const fish = isFishShell();
      // fish 的 config.fish 语法不同，不能写 bash 块。以前 detectRcFile 对 fish 返回 null，
      // 提示却写成“无法识别 shell”，PATH 也不会自动生效
      rc = fish
        ? path.join(os.homedir(), '.config', 'fish', 'config.fish')
        : detectRcFile(platform.os);
      if (rc) {
        try {
          upsertRcFile(rc, type, fish ? rcBlockFish(type) : undefined);
        } catch (err) {
          envState.error = err instanceof Error ? err : new Error(String(err));
        }
      }
    }
  });
  log.ok(`current → ${label}`);

  if (envState.error) {
    log.warn(
      `switched the link, but could not update ${
        platform.os === 'windows' ? 'the user environment' : rc ?? 'the shell rc'
      }: ${envState.error.message}`,
    );
    // 链接已切换，但环境变量/PATH 没跟上——新终端仍解析旧值，结果受影响。
    // 退出码 0 的契约是"警告不影响结果"，这里必须如实报 1，脚本按退出码判断才不会误以为切换生效
    process.exitCode = 1;
    if (platform.os !== 'windows') {
      log.warn('add this to your rc file manually:');
      // rcBlock 是 POSIX 语法，对 fish 不合法
      console.log(isFishShell() ? rcBlockFish(type) : rcBlock(type));
    }
  } else if (platform.os === 'windows') {
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
    // Windows 上 `java use` 把 JAVA_HOME 写进用户注册表，当前进程的 env 感知不到：
    // 注入与否要查注册表，否则刚切完 java 就 use maven 会误报缺 JDK
    let registryJava: string | null = null;
    if (platform.os === 'windows') {
      registryJava = await getEnvWin('JAVA_HOME');
    }
    if (!registryJava) {
      log.warn(`${spec.label} needs a JDK. Run: ${CLI_BIN} java use <version>`);
    }
  }
  await showSdkVersion(path.join(home, spec.binRelPath(platform)), type);
}
