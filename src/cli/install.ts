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
import { applyMirrorDetail, checksumSidecarFallback, MIRROR_REWRITE_VENDORS } from '../vendor/mirror.js';
import { downloadFile, cacheFileName } from '../net/download.js';
import { HttpError } from '../net/http.js';
import { hashFile, verifyChecksum } from '../net/checksum.js';
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

  await withLock(async () => {
    ensureLayout();
    if (fs.existsSync(finalDir)) {
      if (!opts.force) {
        log.warn(`${artifact.displayName} is already installed`);
        log.info(`run: ${cmdPath(type)} use ${hintVersion}`);
        return;
      }
      log.warn(`--force: removing existing ${artifact.dirName}`);
    }

    // 清理残留 .part
    for (const f of fs.readdirSync(paths.cache())) {
      if (f.endsWith('.part')) fs.rmSync(path.join(paths.cache(), f), { force: true });
    }

    if (artifact.archive === 'sh' || artifact.archive === 'exe') {
      assertInstallerPrefix(finalDir, platform.os);
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
    progress.done(dl.bytes, null);

    const actual =
      artifact.checksum?.kind === 'sha512' ? await hashFile(dest, 'sha512') : dl.sha256;
    const fallbackUrl = applied
      ? checksumSidecarFallback(resolved.downloadUrl, resolved.checksum?.url, artifact.downloadUrl)
      : undefined;
    // 安装器（sh/exe）下载后要以用户权限执行：无论是否走镜像，都必须有可核对的哈希
    const strict = applied || artifact.archive === 'sh' || artifact.archive === 'exe';

    const bak = `${finalDir}.bak`;
    try {
      await verifyChecksum(artifact, actual, { strict, fallbackUrl, file: dest });
      if (artifact.archive === 'sh' || artifact.archive === 'exe') {
        // 安装器把 prefix 写进 shebang / conda-meta。先装到临时目录再改名会留下错误路径。
        const existed = fs.existsSync(finalDir);
        let moved = false;
        try {
          fs.rmSync(bak, { recursive: true, force: true });
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
          throw err;
        }
        } else {
        const tmp = tmpExtractDir(paths.tmp());
        let finalTmp = tmp;
        try {
          log.info('extracting ...');
          await extractArchive(dest, artifact.archive, tmp, platform);
          const normalizedRoot = normalizeExtracted(tmp, platform, type).root;
          // 改名进安装目录前审计解压结果：条目不得逃逸 tmp、符号链接不得外指
          assertContained(tmp, normalizedRoot);
          finalTmp = normalizedRoot;
          fs.rmSync(bak, { recursive: true, force: true });
          if (fs.existsSync(finalDir)) fs.renameSync(finalDir, bak);
          try {
            await renameWithRetry(normalizedRoot, finalDir);
          } catch (err) {
            if (fs.existsSync(bak) && !fs.existsSync(finalDir)) {
              try {
                fs.renameSync(bak, finalDir);
              } catch {
                // 回滚失败时保留 bak
              }
            }
            throw err;
          }
          removeBackupQuietly(bak);
        } catch (err) {
          fs.rmSync(finalTmp, { recursive: true, force: true });
          fs.rmSync(tmp, { recursive: true, force: true });
          throw err;
        } finally {
          // 安装目录已经就位时，临时目录被占用不应让这次安装失败
          try {
            fs.rmSync(paths.tmp(), { recursive: true, force: true });
          } catch {
            // 留下 tmp，下次安装会再建
          }
          fs.mkdirSync(paths.tmp(), { recursive: true });
        }
      }
    } finally {
      // 校验或安装任一环节失败都清掉已下载归档，不让未通过校验的包留在 cache/
      fs.rmSync(dest, { force: true });
    }

    log.ok(`installed ${artifact.displayName} → ${finalDir}`);
    log.info(`switch to it: ${cmdPath(type)} use ${refinedUseHint(type, artifact.version, hintVersion)}`);
  });
}
