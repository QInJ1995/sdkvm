import { afterEach, describe, expect, it, vi } from 'vitest';
import { temurinVendor } from '../src/vendor/temurin.js';
import { zuluVendor as zulu, zuluVersionMatches } from '../src/vendor/zulu.js';
import { correttoVendor } from '../src/vendor/corretto.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('temurin', () => {
  it('resolve major via redirect Location', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/v3/binary/latest/21')) return res30x(GH_LOCATION);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = await temurinVendor.resolve({ kind: 'major', major: 21 }, MAC);
    expect(a.downloadUrl).toBe(GH_LOCATION);
    expect(a.dirName).toBe('temurin-21.0.12.1+1');
    expect(a.displayName).toBe('Temurin 21.0.12.1+1');
    expect(a.archive).toBe('tar.gz');
    expect(a.checksum?.url).toBe(`${GH_LOCATION}.json`);
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
      if (u.includes('/v3/binary/latest/25')) {
        return res30x(
          'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4%2B1/OpenJDK25U-jdk_aarch64_mac_hotspot_25.0.4_1.tar.gz',
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = await temurinVendor.resolve({ kind: 'lts' }, MAC);
    expect(a.dirName).toBe('temurin-25.0.4+1');
  });

  it('resolve full constructs GitHub asset URL', async () => {
    const a = await temurinVendor.resolve({ kind: 'full', version: '21.0.5+11' }, MAC);
    expect(a.downloadUrl).toBe(
      'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.5_11.tar.gz',
    );
  });

  it('windows uses zip naming', async () => {
    const a = await temurinVendor.resolve({ kind: 'full', version: '21.0.5+11' }, WIN);
    expect(a.archive).toBe('zip');
    expect(a.downloadUrl).toContain('OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip');
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

  it('no plain jdk → helpful error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resJson([packages[0]])));
    await expect(zulu.resolve({ kind: 'major', major: 21 }, MAC)).rejects.toThrow(/No Zulu JDK build matches/);
  });
});

describe('corretto', () => {
  it('resolve major via 302 Location parse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res30x(
          'https://corretto.aws/downloads/resources/21.0.12.9.1/amazon-corretto-21.0.12.9.1-macosx-aarch64.tar.gz',
        ),
      ),
    );
    const a = await correttoVendor.resolve({ kind: 'major', major: 21 }, MAC);
    expect(a.dirName).toBe('corretto-21.0.12.9.1');
    expect(a.downloadUrl).toBe(
      'https://corretto.aws/downloads/resources/21.0.12.9.1/amazon-corretto-21.0.12.9.1-macosx-aarch64.tar.gz',
    );
    expect(a.checksum?.url).toBe(
      'https://corretto.aws/downloads/resources/21.0.12.9.1/amazon-corretto-21.0.12.9.1-macosx-aarch64.tar.gz.sha256',
    );
  });

  it('resolve full builds resource URL with per-OS naming', async () => {
    const mac = await correttoVendor.resolve({ kind: 'full', version: '21.0.4.9.1' }, MAC);
    expect(mac.downloadUrl).toContain('amazon-corretto-21.0.4.9.1-macosx-aarch64.tar.gz');
    const lin = await correttoVendor.resolve({ kind: 'full', version: '21.0.4.9.1' }, LIN);
    expect(lin.downloadUrl).toContain('amazon-corretto-21.0.4.9.1-linux-x64.tar.gz');
    const win = await correttoVendor.resolve({ kind: 'full', version: '21.0.4.9.1' }, WIN);
    expect(win.downloadUrl).toContain('amazon-corretto-21.0.4.9.1-windows-x64-jdk.zip');
  });

  it('unsupported major throws', async () => {
    await expect(correttoVendor.resolve({ kind: 'major', major: 22 }, MAC)).rejects.toThrow(
      /does not publish/,
    );
  });

  it('listMajors static', async () => {
    const majors = await correttoVendor.listMajors();
    expect(majors.every((m) => m.lts)).toBe(true);
    expect(majors.map((m) => m.key)).toEqual(['8', '11', '17', '21', '25']);
  });
});
