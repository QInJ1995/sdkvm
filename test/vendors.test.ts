import { afterEach, describe, expect, it, vi } from 'vitest';
import { temurinVendor } from '../src/vendor/temurin.js';
import { log } from '../src/ui/log.js';
import { zuluVendor as zulu, zuluVersionMatches } from '../src/vendor/zulu.js';
import { canonicalCorrettoVersion, correttoVendor } from '../src/vendor/corretto.js';

const MAC = { os: 'mac' as const, arch: 'aarch64' as const };
const LIN = { os: 'linux' as const, arch: 'x64' as const };
const WIN = { os: 'windows' as const, arch: 'x64' as const };

const GH_LOCATION =
  'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz';

function res30x(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}

function resJson(body: unknown): Response {
  return Response.json(body);
}

/** v3/assets/latest 响应：package.link 是 GitHub 下载 URL，package.checksum 是官方 sha256 */
function resAsset(major: number, file: string, checksum: string): Response {
  return resJson([
    {
      version_data: { major },
      binary: {
        package: {
          name: file,
          link: `https://github.com/adoptium/temurin${major}-binaries/releases/download/jdk-x/${file}`,
          checksum,
        },
      },
    },
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('temurin', () => {
  it('resolve major via assets API (link + official sha256)', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/v3/assets/latest/21')) {
        return resJson([
          {
            binary: {
              package: {
                link: GH_LOCATION,
                checksum: 'a'.repeat(64),
              },
            },
          },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = await temurinVendor.resolve({ kind: 'major', major: 21 }, MAC);
    expect(a.downloadUrl).toBe(GH_LOCATION);
    expect(a.dirName).toBe('temurin-21.0.12.1+1');
    expect(a.displayName).toBe('Temurin 21.0.12.1+1');
    expect(a.archive).toBe('tar.gz');
    // 官方 API 预取的哈希：镜像模式下不再依赖 GitHub 的 .json 旁路
    expect(a.checksum?.expected).toBe('a'.repeat(64));
  });

  it('resolve lts uses available_releases', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/v3/info/available_releases')) {
        return resJson({
          available_releases: [11, 17, 21, 25],
          available_lts_releases: [21, 25],
        });
      }
      if (u.includes('/v3/assets/latest/25')) {
        return resJson([
          {
            binary: {
              package: {
                link: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4%2B1/OpenJDK25U-jdk_aarch64_mac_hotspot_25.0.4_1.tar.gz',
                checksum: 'b'.repeat(64),
              },
            },
          },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = await temurinVendor.resolve({ kind: 'lts' }, MAC);
    expect(a.dirName).toBe('temurin-25.0.4+1');
    expect(a.checksum?.expected).toBe('b'.repeat(64));
  });

  it('resolve full constructs GitHub asset URL', async () => {
    const a = await temurinVendor.resolve({ kind: 'full', version: '21.0.5+11' }, MAC);
    expect(a.downloadUrl).toBe(
      'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.5_11.tar.gz',
    );
  });

  it('keeps X.0.0 uncollapsed in the asset file name', async () => {
    const a = await temurinVendor.resolve({ kind: 'full', version: '21.0.0' }, MAC);
    expect(a.downloadUrl).toContain('OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.0.tar.gz');
  });

  it('rejects JDK 8 full versions that cannot name a real asset', async () => {
    await expect(temurinVendor.resolve({ kind: 'full', version: '8.0.504' }, LIN)).rejects.toThrow(
      /needs an update\+build version/,
    );
    await expect(temurinVendor.resolve({ kind: 'full', version: '8.0.504.1+1' }, LIN)).rejects.toThrow(
      /needs an update\+build version/,
    );
  });

  it('windows uses zip naming', async () => {
    const a = await temurinVendor.resolve({ kind: 'full', version: '21.0.5+11' }, WIN);
    expect(a.archive).toBe('zip');
    expect(a.downloadUrl).toContain('OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip');
  });

  it('parses a legacy jdk8u asset link into 8.0.<update>+<build>', async () => {
    const location =
      'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jdk_x64_linux_hotspot_8u504b01.tar.gz';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resJson([{ binary: { package: { link: location, checksum: 'c'.repeat(64) } } }])),
    );
    const a = await temurinVendor.resolve({ kind: 'major', major: 8 }, LIN);
    expect(a.downloadUrl).toBe(location);
    expect(a.dirName).toBe('temurin-8.0.504+1');
  });

  it('builds the legacy JDK 8 asset name, padding the build to two digits', async () => {
    const lin = await temurinVendor.resolve({ kind: 'full', version: '8.0.504+1' }, LIN);
    expect(lin.downloadUrl).toBe(
      'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jdk_x64_linux_hotspot_8u504b01.tar.gz',
    );
    const win = await temurinVendor.resolve({ kind: 'full', version: '8.0.472+8' }, WIN);
    expect(win.archive).toBe('zip');
    expect(win.downloadUrl).toBe(
      'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u472-b08/OpenJDK8U-jdk_x64_windows_hotspot_8u472b08.zip',
    );
  });

  it('says when Temurin does not publish that major for this platform', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    await expect(temurinVendor.resolve({ kind: 'major', major: 8 }, MAC)).rejects.toThrow(
      /No Temurin JDK 8 build for mac\/aarch64/,
    );
  });

  it('resolve lts fails clearly when the index has no LTS line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resJson({ available_releases: [22], available_lts_releases: [] })),
    );
    await expect(temurinVendor.resolve({ kind: 'lts' }, MAC)).rejects.toThrow(/No Temurin LTS/);
  });

  it('listMajors maps lts flags', async () => {
    const fetchMock = vi.fn(async () =>
      resJson({ available_releases: [17, 21, 22], available_lts_releases: [21] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const majors = await temurinVendor.listMajors();
    expect(majors).toEqual([
      { key: '17', lts: false },
      { key: '21', lts: true },
      { key: '22', lts: false },
    ]);
  });
});

describe('zulu', () => {
  const packages = [
    { name: 'zulu21.52.203-ca-crac-jdk21.0.12.1-macosx_aarch64.zip', download_url: 'https://cdn.azul.com/crac.zip', java_version: [21, 0, 12, 1], distro_version: [21, 52, 203, 0] },
    { name: 'zulu21.52.203-ca-fx-jdk21.0.12.1-macosx_aarch64.zip', download_url: 'https://cdn.azul.com/fx.zip', java_version: [21, 0, 12, 1], distro_version: [21, 52, 203, 0] },
    { name: 'zulu21.52.203-ca-jre21.0.12.1-macosx_aarch64.zip', download_url: 'https://cdn.azul.com/jre.zip', java_version: [21, 0, 12, 1], distro_version: [21, 52, 203, 0] },
    { name: 'zulu21.52.203-ca-jdk21.0.12.1-macosx_aarch64.dmg', download_url: 'https://cdn.azul.com/jdk.dmg', java_version: [21, 0, 12, 1], distro_version: [21, 52, 203, 0] },
    { name: 'zulu21.52.203-ca-jdk21.0.12.1-macosx_aarch64.tar.gz', download_url: 'https://cdn.azul.com/zulu/bin/zulu21.52.203-ca-jdk21.0.12.1-macosx_aarch64.tar.gz', java_version: [21, 0, 12, 1], distro_version: [21, 52, 203, 0], sha256_hash: 'ab'.repeat(32) },
  ];

  it('version match uses segment boundaries (21.0.1 vs 21.0.10)', () => {
    expect(zuluVersionMatches([21, 0, 1], '21.0.1')).toBe(true);
    expect(zuluVersionMatches([21, 0, 1, 2], '21.0.1')).toBe(true);
    expect(zuluVersionMatches([21, 0, 10], '21.0.1')).toBe(false);
    expect(zuluVersionMatches([21, 0, 12, 1], '21')).toBe(true);
  });

  it('version match strips the +build segment (Azul keeps builds in distro_version)', () => {
    expect(zuluVersionMatches([21, 0, 5], '21.0.5+11')).toBe(true);
    expect(zuluVersionMatches([21, 0, 5, 1], '21.0.5+11')).toBe(true);
    expect(zuluVersionMatches([21, 0, 10], '21.0.5+11')).toBe(false);
  });

  it('full spec with build resolves and distro_version breaks ties', async () => {
    const sameJava = [
      {
        name: 'zulu21.30.15-ca-jdk21.0.5-macosx_aarch64.tar.gz',
        download_url: 'https://cdn.azul.com/zulu/bin/zulu21.30.15.tar.gz',
        java_version: [21, 0, 5],
        distro_version: [21, 30, 15, 0],
        sha256_hash: 'aa'.repeat(32),
      },
      {
        name: 'zulu21.56.17-ca-jdk21.0.5-macosx_aarch64.tar.gz',
        download_url: 'https://cdn.azul.com/zulu/bin/zulu21.56.17.tar.gz',
        java_version: [21, 0, 5],
        distro_version: [21, 56, 17, 0],
        sha256_hash: 'bb'.repeat(32),
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => resJson(sameJava)));
    const a = await zulu.resolve({ kind: 'full', version: '21.0.5+11' }, MAC);
    expect(a.downloadUrl).toBe('https://cdn.azul.com/zulu/bin/zulu21.56.17.tar.gz');
    expect(a.checksum?.expected).toBe('bb'.repeat(32));
  });

  it('full version does not pick a longer patch via string prefix', async () => {
    const mixed = [
      ...packages,
      {
        name: 'zulu21.40-ca-jdk21.0.1-macosx_aarch64.tar.gz',
        download_url: 'https://cdn.azul.com/zulu/bin/zulu21.0.1.tar.gz',
        java_version: [21, 0, 1],
        distro_version: [21, 40, 0, 0],
        sha256_hash: 'cd'.repeat(32),
      },
      {
        name: 'zulu21.50-ca-jdk21.0.10-macosx_aarch64.tar.gz',
        download_url: 'https://cdn.azul.com/zulu/bin/zulu21.0.10.tar.gz',
        java_version: [21, 0, 10],
        distro_version: [21, 50, 0, 0],
        sha256_hash: 'ef'.repeat(32),
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => resJson(mixed)));
    const a = await zulu.resolve({ kind: 'full', version: '21.0.1' }, MAC);
    expect(a.downloadUrl).toBe('https://cdn.azul.com/zulu/bin/zulu21.0.1.tar.gz');
    expect(a.dirName).toBe('zulu-21.0.1');
  });

  it('client-side filter skips crac/fx/jre/dmg and picks platform ext', async () => {
    const fetchMock = vi.fn(async () => resJson(packages));
    vi.stubGlobal('fetch', fetchMock);

    const a = await zulu.resolve({ kind: 'major', major: 21 }, MAC);
    expect(a.downloadUrl).toBe(
      'https://cdn.azul.com/zulu/bin/zulu21.52.203-ca-jdk21.0.12.1-macosx_aarch64.tar.gz',
    );
    expect(a.dirName).toBe('zulu-21.0.12.1');
    expect(a.checksum?.expected).toBe('ab'.repeat(32));
  });

  it('windows prefers zip', async () => {
    const winPkgs = packages.map((p) => ({
      ...p,
      name: p.name.replace('macosx_aarch64', 'win_aarch64'),
    }));
    winPkgs.push({
      name: 'zulu21.52.203-ca-jdk21.0.12.1-win_aarch64.zip',
      download_url: 'https://cdn.azul.com/zulu/bin/zulu21.52.203-ca-jdk21.0.12.1-win_aarch64.zip',
      java_version: [21, 0, 12, 1],
      distro_version: [21, 52, 203, 0],
    });
    vi.stubGlobal('fetch', vi.fn(async () => resJson(winPkgs)));
    const a = await zulu.resolve({ kind: 'major', major: 21 }, WIN);
    expect(a.downloadUrl).toBe(
      'https://cdn.azul.com/zulu/bin/zulu21.52.203-ca-jdk21.0.12.1-win_aarch64.zip',
    );
  });

  it('follows x-pagination so an older build is not hidden past the first page', async () => {
    const old = {
      name: 'zulu8.40.0.13-ca-jdk8.0.202-linux_x64.tar.gz',
      download_url: 'https://cdn.azul.com/zulu8.0.202.tar.gz',
      java_version: [8, 0, 202],
      distro_version: [8, 40, 0, 13],
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const page = new URL(String(url)).searchParams.get('page');
      if (page === '2') {
        return new Response(JSON.stringify([old]), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-pagination': JSON.stringify({ page: 2 }),
          },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-pagination': JSON.stringify({ page: 1, next_page: 2 }),
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const a = await zulu.resolve({ kind: 'full', version: '8.0.202' }, LIN);
    expect(a.downloadUrl).toBe(old.download_url);
    expect(a.dirName).toBe('zulu-8.0.202');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows x-pagination by total_pages (Azul never sends next_page)', async () => {
    // 线上 x-pagination 实际形如 {"total":594,"total_pages":2,"page":1}——没有 next_page 字段
    const old = {
      name: 'zulu8.40.0.13-ca-jdk8.0.202-linux_x64.tar.gz',
      download_url: 'https://cdn.azul.com/zulu8.0.202.tar.gz',
      java_version: [8, 0, 202],
      distro_version: [8, 40, 0, 13],
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const page = new URL(String(url)).searchParams.get('page');
      if (page === '2') {
        return new Response(JSON.stringify([old]), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-pagination': JSON.stringify({ page: 2, total_pages: 2 }),
          },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-pagination': JSON.stringify({ page: 1, total_pages: 2 }),
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const a = await zulu.resolve({ kind: 'full', version: '8.0.202' }, LIN);
    expect(a.downloadUrl).toBe(old.download_url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('no plain jdk → helpful error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resJson([packages[0]])));
    await expect(zulu.resolve({ kind: 'major', major: 21 }, MAC)).rejects.toThrow(/No Zulu JDK build matches/);
  });

  it('loads sha256 from the package detail when the list omits it', async () => {
    const listed = {
      name: 'zulu21.52.203-ca-jdk21.0.12.1-macosx_aarch64.tar.gz',
      download_url: 'https://cdn.azul.com/zulu/bin/zulu21.tar.gz',
      java_version: [21, 0, 12, 1],
      distro_version: [21, 52, 203, 0],
      package_uuid: 'b4998dfa-d693-42ae-b745-e2140eb4ecb9',
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/zulu/packages/b4998dfa')) {
        return resJson({ sha256_hash: 'AB'.repeat(32) });
      }
      return resJson([listed]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const a = await zulu.resolve({ kind: 'major', major: 21 }, MAC);
    expect(a.checksum?.expected).toBe('ab'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still resolves when the checksum detail is unreachable', async () => {
    const listed = {
      name: 'zulu21.52.203-ca-jdk21.0.12.1-macosx_aarch64.tar.gz',
      download_url: 'https://cdn.azul.com/zulu/bin/zulu21.tar.gz',
      java_version: [21, 0, 12, 1],
      distro_version: [21, 52, 203, 0],
      package_uuid: 'missing-hash',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/zulu/packages/missing-hash')) {
          return new Response('no', { status: 404 });
        }
        return resJson([listed]);
      }),
    );
    const a = await zulu.resolve({ kind: 'major', major: 21 }, MAC);
    expect(a.downloadUrl).toBe(listed.download_url);
    expect(a.checksum).toBeNull();
  });
});

describe('corretto', () => {
  it('resolve major via 302 Location parse + latest_sha256', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/latest/')) {
          return res30x(
            'https://corretto.aws/downloads/resources/21.0.12.9.1/amazon-corretto-21.0.12.9.1-macosx-aarch64.tar.gz',
          );
        }
        if (u.includes('/latest_sha256/')) {
          return new Response('d'.repeat(64));
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const a = await correttoVendor.resolve({ kind: 'major', major: 21 }, MAC);
    expect(a.dirName).toBe('corretto-21.0.12.9.1');
    expect(a.downloadUrl).toBe(
      'https://corretto.aws/downloads/resources/21.0.12.9.1/amazon-corretto-21.0.12.9.1-macosx-aarch64.tar.gz',
    );
    // resources 的 .sha256 旁路已 403：major/lts 从 latest_sha256 端点预取官方哈希
    expect(a.checksum?.expected).toBe('d'.repeat(64));
  });

  it('keeps Corretto 8 build numbers zero-padded in the directory and the URL', async () => {
    expect(canonicalCorrettoVersion('8.504.1.1')).toBe('8.504.01.1');
    expect(canonicalCorrettoVersion('8.504.01.1')).toBe('8.504.01.1');
    expect(canonicalCorrettoVersion('8.504.12.1')).toBe('8.504.12.1');
    expect(canonicalCorrettoVersion('21.0.12.9.1')).toBe('21.0.12.9.1');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/latest_sha256/')) return new Response('e'.repeat(64));
        return res30x(
          'https://corretto.aws/downloads/resources/8.504.01.1/amazon-corretto-8.504.01.1-macosx-aarch64.tar.gz',
        );
      }),
    );
    const latest = await correttoVendor.resolve({ kind: 'major', major: 8 }, MAC);
    expect(latest.dirName).toBe('corretto-8.504.01.1');
    expect(latest.downloadUrl).toContain('/8.504.01.1/amazon-corretto-8.504.01.1-macosx-aarch64.tar.gz');

    const collapsed = await correttoVendor.resolve({ kind: 'full', version: '8.504.1.1' }, MAC);
    expect(collapsed.dirName).toBe('corretto-8.504.01.1');
    expect(collapsed.downloadUrl).toContain('amazon-corretto-8.504.01.1-macosx-aarch64.tar.gz');
  });

  it('resolve full builds resource URL with per-OS naming (no checksum source)', async () => {
    const mac = await correttoVendor.resolve({ kind: 'full', version: '21.0.4.9.1' }, MAC);
    expect(mac.downloadUrl).toContain('amazon-corretto-21.0.4.9.1-macosx-aarch64.tar.gz');
    // full 历史版本无公开校验旁路：诚实置 null，安装时 warn 跳过
    expect(mac.checksum).toBeNull();
    const lin = await correttoVendor.resolve({ kind: 'full', version: '21.0.4.9.1' }, LIN);
    expect(lin.downloadUrl).toContain('amazon-corretto-21.0.4.9.1-linux-x64.tar.gz');
    const win = await correttoVendor.resolve({ kind: 'full', version: '21.0.4.9.1' }, WIN);
    expect(win.downloadUrl).toContain('amazon-corretto-21.0.4.9.1-windows-x64-jdk.zip');
  });

  it('unknown major surfaces the latest-endpoint 404 as a clear error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(correttoVendor.resolve({ kind: 'major', major: 22 }, MAC)).rejects.toThrow(
      /No Corretto JDK 22 build for mac\/aarch64/,
    );
  });

  it('full spec with a "+build" segment is rejected with the Corretto syntax hint', async () => {
    await expect(
      correttoVendor.resolve({ kind: 'full', version: '21.0.5+11' }, MAC),
    ).rejects.toThrow(/\+build/);
  });

  it('listMajors probes the latest redirect per major and hides unpublished lines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/v3/info/available_releases')) {
          // Corretto 的 major 全集借道 Adoptium 节奏：8/17/21/22/25
          return resJson({ available_releases: [8, 17, 21, 22, 25], available_lts_releases: [8, 17, 21, 25] });
        }
        if (u.includes('/latest/amazon-corretto-22-')) {
          // Corretto 22 在该平台没发：latest 入口 404
          return new Response(null, { status: 404 });
        }
        const m = /\/latest\/amazon-corretto-(\d+)-/.exec(u);
        if (m && m[1]) {
          return res30x(
            `https://corretto.aws/downloads/resources/${m[1]}.0.8.9.1/amazon-corretto-${m[1]}-macosx-aarch64.tar.gz`,
          );
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const majors = await correttoVendor.listMajors();
      // 22 被探测失败隐藏；非 LTS major 不再被预门禁挡在门外
      expect(majors.map((m) => m.key)).toEqual(['8', '17', '21', '25']);
      expect(majors.every((m) => m.latestFullVersion === `${m.key}.0.8.9.1`)).toBe(true);
      expect(majors.find((m) => m.key === '25')?.lts).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('zulu listMajors', () => {
  it('warns and hides only the failed majors', async () => {
    // listMajors 走 detectPlatform()：mock 的包名必须带宿主平台的归档扩展名，
    // 否则会被 pickPlainJdk 的 ext 过滤掉（Windows 要 .zip，其余 .tar.gz）
    const hostExt = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/v3/info/available_releases')) {
        return resJson({ available_releases: [17, 21], available_lts_releases: [21] });
      }
      if (u.includes('java_version=17')) {
        return resJson([
          {
            name: `zulu17.56.19-ca-jdk17.0.12-host.${hostExt}`,
            download_url: 'https://cdn.azul.com/zulu/bin/z17.tar.gz',
            java_version: [17, 0, 12],
            distro_version: [17, 56, 19, 0],
          },
        ]);
      }
      return new Response('boom', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const lines = await zulu.listMajors();
      expect(lines.map((l) => l.key)).toEqual(['17']);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('21'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('throws when every major fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/v3/info/available_releases')) {
          return resJson({ available_releases: [17], available_lts_releases: [] });
        }
        return new Response('boom', { status: 500 });
      }),
    );
    await expect(zulu.listMajors()).rejects.toThrow(/all majors/);
  });
});

describe('zulu libc 过滤', () => {
  // 本机（mac/windows）与 glibc Linux 都视为 glibc：musl 变体必须被排除
  it('glibc 宿主跳过 musl 变体（沿用既有行为）', async () => {
    const mixed = [
      {
        name: 'zulu21.52.203-ca-jdk21.0.12.1-linux_musl_x64.tar.gz',
        download_url: 'https://cdn.azul.com/zulu/bin/musl.tar.gz',
        java_version: [21, 0, 12, 1],
        distro_version: [21, 52, 203, 0],
        sha256_hash: 'ee'.repeat(32),
      },
      {
        name: 'zulu21.52.203-ca-jdk21.0.12.1-linux_x64.tar.gz',
        download_url: 'https://cdn.azul.com/zulu/bin/glibc.tar.gz',
        java_version: [21, 0, 12, 1],
        distro_version: [21, 52, 203, 0],
        sha256_hash: 'ff'.repeat(32),
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => resJson(mixed)));
    const a = await zulu.resolve({ kind: 'major', major: 21 }, LIN);
    expect(a.downloadUrl).toBe('https://cdn.azul.com/zulu/bin/glibc.tar.gz');
  });

  it('只有 musl 构建时（glibc 宿主）给出无匹配错误而不是选中 musl', async () => {
    const muslOnly = [
      {
        name: 'zulu21.52.203-ca-jdk21.0.12.1-linux_musl_x64.tar.gz',
        download_url: 'https://cdn.azul.com/zulu/bin/musl.tar.gz',
        java_version: [21, 0, 12, 1],
        distro_version: [21, 52, 203, 0],
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => resJson(muslOnly)));
    await expect(zulu.resolve({ kind: 'major', major: 21 }, LIN)).rejects.toThrow(
      /No Zulu JDK build matches/,
    );
  });
});
