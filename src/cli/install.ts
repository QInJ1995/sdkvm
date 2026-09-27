import fs from 'node:fs';
import path from 'node:path';
import { detectPlatform } from '../core/platform.js';
import { loadConfig } from '../core/config.js';
import { withLock } from '../core/lock.js';
import { ensureLayout, paths } from '../core/paths.js';
import { envGet } from '../core/env.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { getVendor, resolveVendorId } from '../vendor/index.js';
import { applyMirrorDetail, checksumSidecarFallback, MIRROR_REWRITE_VENDORS } from '../vendor/mirror.js';
import { downloadFile, cacheFileName } from '../net/download.js';
import { hashFile, verifyChecksum } from '../net/checksum.js';
import { extractArchive, tmpExtractDir } from '../fs/extract.js';
import { assertInstallerPrefix, runSilentInstaller } from '../fs/installer.js';
import { normalizeExtracted } from '../fs/layout.js';
import { SdkvmError } from '../util/errors.js';
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

/** Windows 上杀软可能短暂锁住新解压的文件导致 rename 失败，重试兜底 */
async function renameWithRetry(from: string, to: string, attempts = 3): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      log.warn(`rename blocked (attempt ${i}/${attempts}), retrying in 1s ...`);
      await new Promise((r) => setTimeout(r, 1000));
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
    const dl = await downloadFile(artifact.downloadUrl, dest, (b, t) => progress.update(b, t));
    progress.done(dl.bytes, null);

    const actual =
      artifact.checksum?.kind === 'sha512' ? await hashFile(dest, 'sha512') : dl.sha256;
    const fallbackUrl = applied
      ? checksumSidecarFallback(resolved.downloadUrl, resolved.checksum?.url, artifact.downloadUrl)
      : undefined;
    await verifyChecksum(artifact, actual, { strict: applied, fallbackUrl, file: dest });

    const bak = `${finalDir}.bak`;
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
        fs.rmSync(bak, { recursive: true, force: true });
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
      } finally {
        fs.rmSync(dest, { force: true });
      }
    } else {
      const tmp = tmpExtractDir(paths.tmp());
      let finalTmp = tmp;
      try {
        log.info('extracting ...');
        await extractArchive(dest, artifact.archive, tmp, platform);
        const normalizedRoot = normalizeExtracted(tmp, platform, type).root;
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
        fs.rmSync(bak, { recursive: true, force: true });
      } catch (err) {
        fs.rmSync(finalTmp, { recursive: true, force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
        throw err;
      } finally {
        fs.rmSync(dest, { force: true });
        fs.rmSync(paths.tmp(), { recursive: true, force: true });
        fs.mkdirSync(paths.tmp(), { recursive: true });
      }
    }

    log.ok(`installed ${artifact.displayName} → ${finalDir}`);
    log.info(`switch to it: ${cmdPath(type)} use ${hintVersion}`);
  });
}
