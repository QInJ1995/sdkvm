import fs from 'node:fs';
import path from 'node:path';
import { detectPlatform } from '../core/platform.js';
import { loadConfig } from '../core/config.js';
import { withLock } from '../core/lock.js';
import { listInstalled } from '../core/registry.js';
import { ensureLayout, paths } from '../core/paths.js';
import { envGet } from '../core/env.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { getVendor, resolveVendorId } from '../vendor/index.js';
import { applyMirrorDetail, MIRROR_REWRITE_VENDORS } from '../vendor/mirror.js';
import { downloadFile, cacheFileName } from '../net/download.js';
import { HttpError } from '../net/http.js';
import { hashFile, preflightChecksum, verifyChecksum } from '../net/checksum.js';
import { extractArchive, tmpExtractDir } from '../fs/extract.js';
import { assertInstallerPrefix, runSilentInstaller } from '../fs/installer.js';
import { assertContained, normalizeExtracted } from '../fs/layout.js';
import { SdkvmError } from '../util/errors.js';
import { renameWithRetry } from '../util/rename.js';
import { log } from '../ui/log.js';
import { createProgress } from '../ui/progress.js';
import type { SdkVersion } from '../core/version.js';
import { cmdPath } from './cmdname.js';

/**
 * 安装成功后提示的 `use` 参数。
 * java/node 用 major；go 以及稳定的 flutter/maven/python 用 minor 线。
 * 预发布只能写完整版本：`use 3.14` / `use 4.0` 会跳过它，或切到同线的正式版。
 * miniconda 同一条 minor 线上有多个 Python，也写完整版本。
 */
export function installUseHint(type: SdkTypeId, version: SdkVersion): string {
  const sdk = getSdkType(type);
  if (version.extra && (type === 'python' || type === 'maven' || type === 'flutter')) {
    return sdk.formatVersion(version);
  }
  if (type === 'miniconda') return sdk.formatVersion(version);
  if (type === 'java' || type === 'node') return String(version.major);
  return `${version.major}.${version.minor}`;
}

/**
 * 安装成功后的 use 提示。java/node 的 `use <major>` 会选中该 major 下最新的已装版本；
 * 刚装的不是最新（之前装过更新的）时退回完整版本号，避免提示把用户切到别的版本。
 */
export function refinedUseHint(type: SdkTypeId, version: SdkVersion, hint: string): string {
  if (type !== 'java' && type !== 'node') return hint;
  const sdk = getSdkType(type);
  // `use <major>` 不带 vendor 前缀：跨 vendor 取该 major 最新。任何更新的已装版本都会让提示切走，
  // 此时给带 vendor 的完整规格才指得回刚装的这份
  const newerPeer = listInstalled(type).some(
    (j) => j.version.major === version.major && sdk.compareVersions(j.version, version) > 0,
  );
  return newerPeer ? `${version.vendor}-${sdk.formatVersion(version)}` : hint;
}

/** 安装已就位后清理备份失败不应让这次安装报失败 */
function removeBackupQuietly(bak: string): void {
  try {
    fs.rmSync(bak, { recursive: true, force: true });
  } catch (err) {
    log.warn(
      `installed, but could not remove the old backup ${bak}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** 写 .incomplete 标记。内容记录"当时是否移走了旧目录"：恢复时据此区分
 *  finalDir 是半成品（新装）还是从未被动过的旧安装（换位前被中断）。 */
function writeIncompleteMarker(incomplete: string, replacing: boolean): void {
  fs.writeFileSync(incomplete, JSON.stringify({ startedAt: Date.now(), replacing }));
}

/**
 * 处理被硬中断（kill -9/断电）的安装：安装器直接写 finalDir、归档换位也可能停在半途，
 * 半成品目录会被 existsSync 误判成"已安装"。按 .incomplete 标记恢复 .bak 里的旧安装
 * 或清掉半成品；标记缺失时把 finalDir 原样保留（宁可信其完好）。
 */
function recoverInterrupted(finalDir: string): void {
  const incomplete = `${finalDir}.incomplete`;
  if (!fs.existsSync(incomplete)) return;
  const bak = `${finalDir}.bak`;
  const name = path.basename(finalDir);
  // 新格式标记带 replacing；纯时间戳的旧格式无法判断语义，按保守路径处理
  let replacing = false;
  let legacy = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(incomplete, 'utf8')) as { replacing?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.replacing === 'boolean') {
      replacing = parsed.replacing;
      legacy = false;
    }
  } catch {
    // 保留 legacy 判定
  }
  try {
    if (fs.existsSync(bak)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(bak, finalDir);
      log.warn(`recovered the previous ${name} after an interrupted install`);
    } else if (fs.existsSync(finalDir) && (replacing || legacy)) {
      // 换位从未发生（或旧格式无法判断）：finalDir 是完好的旧版本，只清标记
      log.warn(`an earlier install of ${name} was interrupted before it made changes; kept the existing directory`);
    } else {
      fs.rmSync(finalDir, { recursive: true, force: true });
      log.warn(`removed the interrupted install of ${name}; reinstalling`);
    }
    fs.rmSync(incomplete, { force: true });
  } catch (err) {
    log.warn(`could not clean up the interrupted install of ${name}: ${(err as Error).message}`);
  }
}

/** 安装失败后按实际落盘状态决定 .incomplete 标记的去留：只有仍需下次恢复的残留才保留。
 *  标记多留一刻，registry 就把完好的安装多隐藏一刻，还会被下次 recoverInterrupted 当半成品删掉。 */
function settleIncompleteMarker(
  finalDir: string,
  incomplete: string,
  bak: string,
  existed: boolean,
  moved: boolean,
): void {
  // 旧版本完好：换位从未发生，或回滚已成功
  const finalDirGood = existed && (!moved || (fs.existsSync(finalDir) && !fs.existsSync(bak)));
  const allGone = !fs.existsSync(finalDir) && !fs.existsSync(bak);
  if (finalDirGood || allGone) {
    try {
      fs.rmSync(incomplete, { force: true });
    } catch {
      // 删不掉只能留下，下次恢复时清理
    }
  }
}

/**
 * 清扫该类型安装根目录里的硬中断残留：逐个恢复带 .incomplete 标记的半成品，
 * 换回没有任何归属的孤儿 .bak（标记与 finalDir 都不在——上次换位刚改一半就没了）。
 */
export function recoverInterruptedInstalls(type: SdkTypeId): void {
  const root = paths.sdks(type);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return; // 该类型还没有安装目录
  }
  for (const name of names) {
    if (name.endsWith('.incomplete')) {
      recoverInterrupted(path.join(root, name.slice(0, -'.incomplete'.length)));
    }
  }
  for (const name of names) {
    if (!name.endsWith('.bak')) continue;
    const finalDir = path.join(root, name.slice(0, -'.bak'.length));
    // 标记在 → 上面一轮已处理；finalDir 在 → 上次换位其实成功了，只是 bak 没清掉
    if (fs.existsSync(`${finalDir}.incomplete`) || fs.existsSync(finalDir)) continue;
    try {
      fs.renameSync(path.join(root, name), finalDir);
      log.warn(`recovered ${path.basename(finalDir)} from a leftover .bak after an interrupted swap`);
    } catch {
      // 换不回去就留着，不影响本次安装
    }
  }
}

/** .part 残留（kill -9 / Windows 上被杀软锁住删不掉）按龄清扫：下载在锁外进行，
 *  别的进程可能正在写自己的 .part——活跃下载每个 chunk 都会刷新 mtime，不会误伤。 */
const PART_STALE_MS = 60 * 60 * 1000;

export function sweepStaleParts(): void {
  let names: string[];
  try {
    names = fs.readdirSync(paths.cache());
  } catch {
    return;
  }
  const cutoff = Date.now() - PART_STALE_MS;
  for (const f of names) {
    if (!f.endsWith('.part')) continue;
    const file = path.join(paths.cache(), f);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // 恰好消失或被占用：跳过
    }
  }
}

export async function installCommand(
  type: SdkTypeId,
  specInput: string,
  opts: { vendor?: string; force?: boolean },
): Promise<void> {
  const platform = detectPlatform();
  const config = loadConfig();
  const sdk = getSdkType(type);
  const { vendor: specVendor, spec } = sdk.parseUserSpec(specInput);
  const vendorId = resolveVendorId(type, specVendor ?? opts.vendor, config);
  const vendor = getVendor(type, vendorId);

  log.info(`resolving ${vendor.label} ${specInput} for ${platform.os}/${platform.arch} ...`);
  const resolved = await vendor.resolve(spec, platform);
  const mirrorRoot = envGet('SDKVM_MIRROR') ?? config.mirror[vendorId] ?? null;
  const { artifact, applied } = applyMirrorDetail(resolved, platform, mirrorRoot);
  if (applied && /^http:\/\//i.test(mirrorRoot ?? '')) {
    // 明文镜像只丢机密性（完整性仍由官方源哈希兜底），但用户应当知情
    log.warn(`mirror root is plain http:// — downloads from it are not encrypted`);
  }
  if (mirrorRoot?.trim() && !applied) {
    if (!MIRROR_REWRITE_VENDORS.has(vendorId)) {
      log.warn(
        `mirror is set but ${vendorId} downloads are not mirrored; using the official URL`,
      );
    } else {
      log.warn(
        `mirror root did not rewrite the download URL for ${vendorId}; using the official source`,
      );
    }
  }

  const finalDir = path.join(paths.sdks(type), artifact.dirName);
  const hintVersion = installUseHint(type, artifact.version);
  const installerMode = artifact.archive === 'sh' || artifact.archive === 'exe';
  const reportAlreadyInstalled = (): void => {
    log.warn(`${artifact.displayName} is already installed`);
    // 与成功路径一致：`use <major>` 命中更新的已装版本时退回完整规格
    log.info(`run: ${cmdPath(type)} use ${refinedUseHint(type, artifact.version, hintVersion)}`);
  };

  // ---- 锁外阶段：只读全局状态、只写 cache/ 与 tmp/ 下的私有文件 ----
  // 下载/校验/解压不再持全局锁，长下载不再阻塞 use/uninstall/ls 和别的安装
  ensureLayout();
  if (installerMode) {
    // 安装器把 prefix 写进载荷：prefix 不可用就别白下载几百 MB
    assertInstallerPrefix(finalDir, platform.os);
  }

  // 安装器（sh/exe）下载后要以用户权限执行：无论是否走镜像，都必须有可核对的哈希。
  // 走镜像时同样严格：期望哈希只能来自官方源（checksum.ts 不再接受镜像旁路）
  const strict = applied || installerMode;
  // strict 且哈希还要事后取时先取：官方校验源不通就别白下载几百 MB
  const prefetched = await preflightChecksum(artifact, strict);

  // 咨询式预检（只读）：已安装且无中断标记就别白下载。
  // 竞态窗口内另一进程可能正在装同一版本，锁内还有权威检查兜底
  if (!opts.force && fs.existsSync(finalDir) && !fs.existsSync(`${finalDir}.incomplete`)) {
    reportAlreadyInstalled();
    return;
  }

  const dest = path.join(paths.cache(), cacheFileName(artifact.downloadUrl));
  const progress = createProgress(`↓ ${artifact.displayName}`);
  log.info(`downloading ${artifact.downloadUrl}`);
  let dl: Awaited<ReturnType<typeof downloadFile>>;
  try {
    dl = await downloadFile(artifact.downloadUrl, dest, (b, t) => progress.update(b, t));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404 && vendorId === 'temurin') {
      // full 版本拼出的 asset 名可能不存在（早期 JDK 命名差异）
      throw new SdkvmError(`Temurin has no asset for ${specInput}`, {
        hint: `Check real builds at https://github.com/adoptium/temurin${artifact.version.major}-binaries, or install the line: ${cmdPath(type)} install ${artifact.version.major}`,
      });
    }
    throw err;
  }
  progress.done(dl.bytes, dl.total);

  const actual =
    artifact.checksum?.kind === 'sha512' ? await hashFile(dest, 'sha512') : dl.sha256;

  const tmp = tmpExtractDir(paths.tmp());
  try {
    await verifyChecksum(artifact, actual, { strict, file: dest, prefetched });

    // 解压到私有 tmp 同样在锁外：不碰安装目录，2GB 的 Flutter 解压几十秒也不占锁
    let preparedRoot: string | null = null;
    if (artifact.archive !== 'sh' && artifact.archive !== 'exe') {
      log.info('extracting ...');
      await extractArchive(dest, artifact.archive, tmp, platform);
      const normalizedRoot = normalizeExtracted(tmp, platform, type).root;
      // 改名进安装目录前审计解压结果：条目不得逃逸 tmp、符号链接不得外指
      assertContained(tmp, normalizedRoot);
      preparedRoot = normalizedRoot;
    }

    // ---- 变更阶段：锁只覆盖安装目录的换位与安装器执行 ----
    await withLock(async () => {
      recoverInterruptedInstalls(type);
      if (fs.existsSync(finalDir)) {
        if (!opts.force) {
          reportAlreadyInstalled();
          return;
        }
        log.warn(`--force: removing existing ${artifact.dirName}`);
      }
      sweepStaleParts();

      const bak = `${finalDir}.bak`;
      const incomplete = `${finalDir}.incomplete`;
      if (artifact.archive === 'sh' || artifact.archive === 'exe') {
        // 安装器把 prefix 写进 shebang / conda-meta。先装到临时目录再改名会留下错误路径。
        // 目录名旁的 .incomplete 标记用于识别被硬中断（kill -9/断电）的半成品：
        // 安装器直接写 finalDir，没有 tmp+rename 的原子性
        const existed = fs.existsSync(finalDir);
        let moved = false;
        try {
          fs.rmSync(bak, { recursive: true, force: true });
          writeIncompleteMarker(incomplete, existed);
          if (existed) {
            fs.renameSync(finalDir, bak);
            moved = true;
          }
          log.info('running installer ...');
          await runSilentInstaller(dest, artifact.archive, finalDir, platform.os);
          const normalized = normalizeExtracted(finalDir, platform, type);
          if (path.resolve(normalized.root) !== path.resolve(finalDir)) {
            throw new SdkvmError(`Miniconda installer did not populate ${finalDir}`, {
              hint: `expected the prefix itself, found ${normalized.root}`,
            });
          }
          fs.rmSync(incomplete, { force: true });
          removeBackupQuietly(bak);
        } catch (err) {
          if (moved || !existed) {
            try {
              fs.rmSync(finalDir, { recursive: true, force: true });
            } catch {
              // 删不掉半成品时保留 bak，把安装器的错误抛回去
            }
          }
          if (moved && fs.existsSync(bak) && !fs.existsSync(finalDir)) {
            try {
              fs.renameSync(bak, finalDir);
            } catch {
              // 回滚失败时保留 bak
            }
          }
          settleIncompleteMarker(finalDir, incomplete, bak, existed, moved);
          throw err;
        }
      } else if (preparedRoot !== null) {
        const existed = fs.existsSync(finalDir);
        let moved = false;
        try {
          fs.rmSync(bak, { recursive: true, force: true });
          if (existed) {
            // 标记先于换位写入：finalDir 被改名移走后，只有它能证明 bak 的归属
            writeIncompleteMarker(incomplete, true);
            fs.renameSync(finalDir, bak);
            moved = true;
          }
          await renameWithRetry(preparedRoot, finalDir);
          fs.rmSync(incomplete, { force: true });
          removeBackupQuietly(bak);
        } catch (err) {
          if (moved && fs.existsSync(bak) && !fs.existsSync(finalDir)) {
            try {
              fs.renameSync(bak, finalDir);
            } catch {
              // 回滚失败时保留 bak
            }
          }
          settleIncompleteMarker(finalDir, incomplete, bak, existed, moved);
          throw err;
        }
      }

      log.ok(`installed ${artifact.displayName} → ${finalDir}`);
      log.info(`switch to it: ${cmdPath(type)} use ${refinedUseHint(type, artifact.version, hintVersion)}`);
    });
  } finally {
    // 校验或安装任一环节失败都清掉已下载归档，不让未通过校验的包留在 cache/
    fs.rmSync(dest, { force: true });
    // 只清自己的 tmp：解压在锁外进行，tmp/ 下可能还有别的进程在用的兄弟目录
    if (!installerMode) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // 留下的 tmp 下次安装以新名字重建（tmpExtractDir 带时间戳），无害
      }
    }
  }
}
