import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractExpectedChecksum, preflightChecksum, verifyChecksum } from '../src/net/checksum.js';
import { SdkvmError } from '../src/util/errors.js';
import { log } from '../src/ui/log.js';
import type { ResolvedArtifact } from '../src/vendor/types.js';
import { parseVersion } from '../src/core/version.js';

function art(partial: Partial<ResolvedArtifact> = {}): ResolvedArtifact {
  return {
    vendorId: 'temurin',
    version: parseVersion('temurin', '21.0.1+1'),
    dirName: 'temurin-21.0.1+1',
    displayName: 'Temurin 21.0.1+1',
    downloadUrl: 'https://example.com/a.tar.gz',
    checksum: null,
    archive: 'tar.gz',
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('extractExpectedChecksum', () => {
  const hash = 'ab'.repeat(32);

  it('reads a bare hash or a sha256.txt line', () => {
    expect(extractExpectedChecksum(`${hash}\n`)).toBe(hash);
    expect(extractExpectedChecksum(`${hash.toUpperCase()}  file.tar.gz`)).toBe(hash);
  });

  it('reads Adoptium metadata sha256 and the older checksum field', () => {
    expect(extractExpectedChecksum(JSON.stringify({ sha256: hash, vendor: 'Eclipse Adoptium' }))).toBe(
      hash,
    );
    expect(extractExpectedChecksum(JSON.stringify({ checksum: hash }))).toBe(hash);
  });

  it('reads Adoptium release_name JSON (array of binary.package.checksum)', () => {
    expect(
      extractExpectedChecksum(
        JSON.stringify([
          { binary: { package: { checksum: hash, link: 'https://example.com/jdk.tar.gz' } } },
        ]),
      ),
    ).toBe(hash);
  });

  it('reads a SHA-256 entry from the legacy hashes array', () => {
    expect(
      extractExpectedChecksum(
        JSON.stringify({
          hashes: [
            { alg: 'SHA-1', content: 'aa'.repeat(20) },
            { alg: 'SHA-256', content: hash },
          ],
        }),
      ),
    ).toBe(hash);
  });

  it('reads a sha512 sidecar line', () => {
    const hash = 'ab'.repeat(64);
    expect(extractExpectedChecksum(`${hash}  apache-maven-3.9.9-bin.tar.gz\n`, 'sha512')).toBe(hash);
    expect(extractExpectedChecksum(`${hash}\n`, 'sha256')).toBeNull();
  });

  it('returns null when the JSON has no hash', () => {
    expect(extractExpectedChecksum(JSON.stringify({ vendor: 'Eclipse Adoptium' }))).toBeNull();
    expect(extractExpectedChecksum('{')).toBeNull();
  });

  it('reads BSD checksum format (shasum --tag / openssl dgst)', () => {
    expect(extractExpectedChecksum(`SHA256 (maven.tar.gz) = ${hash}\n`)).toBe(hash);
    // openssl 现代输出是 SHA2-256
    expect(extractExpectedChecksum(`SHA2-256 (maven.tar.gz) = ${hash}\n`)).toBe(hash);
    const sha1 = 'ab'.repeat(20);
    expect(extractExpectedChecksum(`SHA1 (maven.zip) = ${sha1}\n`, 'sha1')).toBe(sha1);
    // sha256 模式不认 SHA1 行
    expect(extractExpectedChecksum(`SHA1 (maven.zip) = ${sha1}\n`)).toBeNull();
  });

  it('multi-entry sums file picks the line whose filename matches the artifact', () => {
    const other = 'cd'.repeat(32);
    const sums = `${other}  some-other-artifact.tar.gz\n${hash}  maven.tar.gz\n${other}  third.zip\n`;
    expect(extractExpectedChecksum(sums, 'sha256', 'maven.tar.gz')).toBe(hash);
    // ./ 前缀与子路径形式同样命中
    expect(extractExpectedChecksum(`${other}  x.tar.gz\n${hash}  ./maven.tar.gz\n`, 'sha256', 'maven.tar.gz')).toBe(hash);
    expect(extractExpectedChecksum(`${other}  x.tar.gz\n${hash}  rel/dir/maven.tar.gz\n`, 'sha256', 'maven.tar.gz')).toBe(hash);
    // 文件名对不上时退回第一条（单行裸哈希文件的语义）
    expect(extractExpectedChecksum(sums, 'sha256', 'not-present.tar.gz')).toBe(other);
    // BSD 多行同理按文件名挑行
    expect(
      extractExpectedChecksum(`SHA256 (x.tar.gz) = ${other}\nSHA256 (maven.tar.gz) = ${hash}\n`, 'sha256', 'maven.tar.gz'),
    ).toBe(hash);
  });
});

describe('verifyChecksum', () => {
  it('warns and skips when no checksum in non-strict mode', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await verifyChecksum(art(), 'a'.repeat(64));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no checksum source'));
  });

  it('strict mode fails when checksum source is missing', async () => {
    await expect(verifyChecksum(art(), 'a'.repeat(64), { strict: true })).rejects.toBeInstanceOf(
      SdkvmError,
    );
  });

  it('strict mode fails when checksum URL cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(
      verifyChecksum(
        art({ checksum: { kind: 'sha256', url: 'https://example.com/a.tar.gz.json' } }),
        'a'.repeat(64),
        { strict: true },
      ),
    ).rejects.toThrow(/Cannot fetch the official checksum/);
  });

  it('strict mode accepts Adoptium metadata sha256', async () => {
    const hash = 'ab'.repeat(32);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sha256: hash }))),
    );
    await verifyChecksum(
      art({ checksum: { kind: 'sha256', url: 'https://example.com/a.tar.gz.json' } }),
      hash,
      { strict: true },
    );
  });

  it('accepts inline expected hash', async () => {
    await verifyChecksum(
      art({ checksum: { kind: 'sha256', expected: 'ab'.repeat(32) } }),
      'AB'.repeat(32),
    );
  });

  it('strict mode fails closed when the official checksum URL is unreachable (mirror sidecar must not define the hash)', async () => {
    const hash = 'ab'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('repo.maven.apache.org')) throw new Error('network down');
        if (u.includes('maven.aliyun.com')) return new Response(`${hash}  file.tar.gz\n`);
        throw new Error(`unexpected ${u}`);
      }),
    );
    // 镜像旁路有合法哈希也不能用：归档与旁路同受镜像控制，校验会形同虚设
    await expect(
      verifyChecksum(
        art({
          displayName: 'Apache Maven 3.9.9',
          checksum: {
            kind: 'sha512',
            url: 'https://repo.maven.apache.org/maven2/apache-maven-3.9.9-bin.tar.gz.sha512',
          },
        }),
        hash,
        { strict: true },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Cannot fetch the official checksum/),
      hint: expect.stringMatching(/unset the mirror/),
    });
  });

  it('strict mode still fails when the official checksum URL has no network at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(
      verifyChecksum(
        art({
          checksum: { kind: 'sha512', url: 'https://repo.maven.apache.org/maven2/a.tar.gz.sha512' },
        }),
        'ab'.repeat(64),
        { strict: true },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Cannot fetch the official checksum/),
      hint: expect.stringMatching(/unset the mirror/),
    });
  });

  it('strict mode verifies Maven 3.8 with sha1 when sha512 sidecars 404', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-sha1-'));
    const file = path.join(dir, 'apache-maven-3.8.9-bin.tar.gz');
    fs.writeFileSync(file, 'maven-3.8.9');
    const sha1 = crypto.createHash('sha1').update('maven-3.8.9').digest('hex');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('.sha512')) return new Response('missing', { status: 404 });
        if (u.endsWith('.sha1') && u.includes('repo.maven.apache.org')) return new Response(`${sha1}\n`);
        throw new Error(`unexpected ${u}`);
      }),
    );
    await verifyChecksum(
      art({
        displayName: 'Apache Maven 3.8.9',
        checksum: {
          kind: 'sha512',
          url: 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.8.9/apache-maven-3.8.9-bin.tar.gz.sha512',
        },
      }),
      'ab'.repeat(64),
      {
        strict: true,
        file,
      },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('verifying with sha1'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strict mode reports unreachable when sha512 is 404 and sha1 cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('.sha512')) return new Response('missing', { status: 404 });
        throw new Error('network down');
      }),
    );
    await expect(
      verifyChecksum(
        art({
          displayName: 'Apache Maven 3.8.9',
          checksum: {
            kind: 'sha512',
            url: 'https://repo.maven.apache.org/maven2/a.tar.gz.sha512',
          },
        }),
        'ab'.repeat(64),
        { strict: true },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Cannot fetch the official checksum/),
      hint: expect.stringMatching(/unset the mirror/),
    });
  });

  it('mismatch always fails', async () => {
    await expect(
      verifyChecksum(art({ checksum: { kind: 'sha256', expected: 'ab'.repeat(32) } }), 'cd'.repeat(32)),
    ).rejects.toThrow(/Checksum mismatch/);
  });
});

describe('preflightChecksum', () => {
  it('expected 已内嵌时不发请求，直接返回 null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      preflightChecksum(art({ checksum: { kind: 'sha256', expected: 'ab'.repeat(32) } }), true),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非 strict 模式不预检', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      preflightChecksum(art({ checksum: { kind: 'sha256', url: 'https://example.com/a.json' } }), false),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strict 下官方源不可达 → 下载前失败（不再白下载归档）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('github blocked');
      }),
    );
    await expect(
      preflightChecksum(art({ checksum: { kind: 'sha256', url: 'https://github.com/a.json' } }), true),
    ).rejects.toThrow(/official checksum|Cannot fetch/);
  });

  it('命中的哈希可被 verifyChecksum 复用，不重复请求', async () => {
    const hash = 'cd'.repeat(32);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sha256: hash })));
    vi.stubGlobal('fetch', fetchMock);
    const artifact = art({ checksum: { kind: 'sha256', url: 'https://example.com/a.tar.gz.json' } });
    const hit = await preflightChecksum(artifact, true);
    expect(hit?.expected).toBe(hash);
    await verifyChecksum(artifact, hash, { strict: true, prefetched: hit });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
