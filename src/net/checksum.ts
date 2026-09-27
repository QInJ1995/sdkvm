import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ResolvedArtifact } from '../vendor/types.js';
import { HttpError, httpText } from './http.js';
import { SdkvmError } from '../util/errors.js';
import { log } from '../ui/log.js';

const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

export type ChecksumKind = 'sha1' | 'sha256' | 'sha512';

function hexOf(value: unknown, kind: ChecksumKind): string | null {
  const re = kind === 'sha512' ? HEX128 : kind === 'sha1' ? HEX40 : HEX64;
  return typeof value === 'string' && re.test(value) ? value.toLowerCase() : null;
}

function hex64(value: unknown): string | null {
  return hexOf(value, 'sha256');
}

/**
 * 解析一行 `sha256sum` 输出。文本模式是 `hash  file`，二进制模式是 `hash *file`。
 * 星号属于模式标记，不是文件名。
 */
export function parseSha256SumLine(line: string): { hash: string; name: string } | null {
  const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
  const hash = match?.[1];
  const name = match?.[2];
  if (!hash || !name) return null;
  return { hash: hash.toLowerCase(), name };
}

/**
 * 从校验源文本提取期望值：
 * - "<hash>" / "<hash>  filename"（.sha1 / .sha256 / .sha512）
 * - Adoptium 资产 JSON 的 checksum，或当前 *.tar.gz.json 元数据的 sha256
 * - 旧版元数据 hashes[].content（alg 为 SHA-256）
 */
export function extractExpectedChecksum(text: string, kind: ChecksumKind = 'sha256'): string | null {
  const trimmed = text.trim();
  if (kind === 'sha256' && trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as {
        checksum?: unknown;
        sha256?: unknown;
        hashes?: unknown;
      };
      const direct = hex64(obj.checksum) ?? hex64(obj.sha256);
      if (direct) return direct;
      if (Array.isArray(obj.hashes)) {
        for (const item of obj.hashes) {
          if (!item || typeof item !== 'object') continue;
          const hash = item as { alg?: unknown; content?: unknown };
          const alg = typeof hash.alg === 'string' ? hash.alg.toLowerCase().replace(/-/g, '') : '';
          if (alg === 'sha256') {
            const content = hex64(hash.content);
            if (content) return content;
          }
        }
      }
    } catch {
      // 非法 JSON 视为无校验
    }
    return null;
  }
  const token = trimmed.split(/\s+/)[0] ?? '';
  return hexOf(token, kind);
}

/** 对已落盘的归档再算一遍哈希（Maven 的官方旁路是 sha512，下载流只累计 sha256） */
export function hashFile(file: string, algorithm: ChecksumKind): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => {
        hash.update(chunk);
      })
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export interface VerifyChecksumOptions {
  /**
   * 严格模式（走镜像下载时开启）：官方与镜像旁路都拿不到校验值时硬失败，
   * 避免无法核对的镜像包被静默放行。哈希不匹配始终硬失败。
   */
  strict?: boolean;
  /**
   * 官方校验 URL 失败或没有有效哈希时再试一次。
   * 通常是镜像上与归档同路径的旁路文件（`.sha512` / `.json`）。
   */
  fallbackUrl?: string;
  /** 已下载的归档。SHA-512 不存在、改用 SHA-1 时用来重算哈希 */
  file?: string;
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

function sha1Sidecar(url: string | undefined): string | undefined {
  if (!url?.endsWith('.sha512')) return undefined;
  return `${url.slice(0, -'.sha512'.length)}.sha1`;
}

interface ChecksumHit {
  expected: string;
  kind: ChecksumKind;
}

/**
 * 按顺序试校验源。404 视为「这个算法的旁路不存在」，继续下一个；
 * 网络错误才算不可达。Maven 3.8 及更早只有 .sha1，没有 .sha512。
 */
async function loadChecksum(
  artifact: ResolvedArtifact,
  primaryKind: ChecksumKind,
  officialUrl: string,
  mirrorUrl: string | undefined,
  strict: boolean,
): Promise<ChecksumHit | null> {
  const sameKind = [officialUrl, mirrorUrl].filter((url): url is string => Boolean(url));
  let missing = false;
  let networkErr: unknown;
  for (let i = 0; i < sameKind.length; i++) {
    const url = sameKind[i] as string;
    try {
      const expected = extractExpectedChecksum(await httpText(url), primaryKind);
      if (expected) {
        if (i > 0) {
          log.warn(`official checksum unreachable for ${artifact.displayName}, verified with mirror sidecar`);
        }
        return { expected, kind: primaryKind };
      }
      missing = true;
    } catch (err) {
      if (isNotFound(err)) {
        missing = true;
        continue;
      }
      networkErr = err;
      if (i === 0 && mirrorUrl) {
        log.warn(`cannot fetch official checksum for ${artifact.displayName}, trying the mirror sidecar`);
      }
    }
  }

  const sha1Urls = [sha1Sidecar(officialUrl), sha1Sidecar(mirrorUrl)].filter((url): url is string => Boolean(url));
  if (missing && sha1Urls.length > 0) {
    for (const url of sha1Urls) {
      try {
        const expected = extractExpectedChecksum(await httpText(url), 'sha1');
        if (!expected) continue;
        log.warn(`no ${primaryKind} sidecar for ${artifact.displayName}, verifying with sha1`);
        return { expected, kind: 'sha1' };
      } catch (err) {
        if (isNotFound(err)) continue;
        networkErr = err;
      }
    }
  }

  // 有过网络失败就不能当成「文件里没有哈希」：404 只说明这个算法的旁路不存在，
  // 另一条 URL 连不上时仍然应该报不可达，让安装重试而不是换一套错误提示。
  if (networkErr) {
    if (strict) {
      const detail = networkErr instanceof Error ? networkErr.message.split('\n')[0] : String(networkErr);
      throw new SdkvmError(`Cannot fetch checksum for ${artifact.displayName}`, {
        hint: `${detail}. Official and mirror checksum URLs were both unreachable.`,
      });
    }
    log.warn(`cannot fetch checksum for ${artifact.displayName}, skipping verification`);
    return null;
  }
  if (!missing) return null;
  if (strict) {
    throw new SdkvmError(`Checksum source has no valid hash for ${artifact.displayName}`, {
      hint: 'Mirrored downloads require a verifiable checksum.',
    });
  }
  log.warn(`checksum source has no valid hash for ${artifact.displayName}, skipping`);
  return null;
}

/** 尽力校验：来源缺失/获取失败 → warn 放行（strict 且无可用旁路时硬失败）；不匹配 → 硬失败 */
export async function verifyChecksum(
  artifact: ResolvedArtifact,
  actual: string,
  opts: VerifyChecksumOptions = {},
): Promise<void> {
  const strict = opts.strict === true;
  const info = artifact.checksum;
  if (!info) {
    if (strict) {
      throw new SdkvmError(`No checksum source for ${artifact.displayName}`, {
        hint: 'Mirrored downloads require a verifiable checksum; unset the mirror or use the official source.',
      });
    }
    log.warn(`no checksum source for ${artifact.displayName}, skipping verification`);
    return;
  }
  let expected: string | null = info.expected?.toLowerCase() ?? null;
  let kind: ChecksumKind = info.kind;
  if (!expected && info.url) {
    const fallback = opts.fallbackUrl && opts.fallbackUrl !== info.url ? opts.fallbackUrl : undefined;
    const hit = await loadChecksum(artifact, info.kind, info.url, fallback, strict);
    if (!hit) return;
    expected = hit.expected;
    kind = hit.kind;
  }
  if (!expected) {
    if (strict) {
      throw new SdkvmError(`Checksum source has no valid hash for ${artifact.displayName}`, {
        hint: 'Mirrored downloads require a verifiable checksum.',
      });
    }
    log.warn(`checksum source has no valid hash for ${artifact.displayName}, skipping`);
    return;
  }
  const digest = kind === info.kind ? actual : opts.file ? await hashFile(opts.file, kind) : null;
  if (!digest) {
    throw new SdkvmError(`Cannot verify ${artifact.displayName} with ${kind}`, {
      hint: 'The downloaded archive is required to rehash with a fallback checksum algorithm.',
    });
  }
  if (expected !== digest.toLowerCase()) {
    throw new SdkvmError(`Checksum mismatch for ${artifact.displayName}`, {
      hint: `expected ${expected}, got ${digest}`,
    });
  }
}
