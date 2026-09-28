import { afterEach, describe, expect, it, vi } from 'vitest';
import { pythonSdk } from '../src/sdk/python.js';
import {
  CPYTHON_DOWNLOAD_PREFIX,
  cpythonVendor,
  parsePythonSums,
  pickPythonVersion,
  preferStripped,
  pythonReleaseLines,
  pythonTriple,
} from '../src/vendor/python.js';
import { comparePythonVersions, compareVersions, formatPythonVersion, parsePythonVersion } from '../src/core/version.js';

const MAC = { os: 'mac' as const, arch: 'aarch64' as const };
const MAC_X64 = { os: 'mac' as const, arch: 'x64' as const };
const LIN = { os: 'linux' as const, arch: 'x64' as const };
const LIN_ARM = { os: 'linux' as const, arch: 'aarch64' as const };
const WIN = { os: 'windows' as const, arch: 'x64' as const };
const WIN_ARM = { os: 'windows' as const, arch: 'aarch64' as const };

const TAG = '20260924';
const PREFIX = `${CPYTHON_DOWNLOAD_PREFIX}/${TAG}`;

const SHA = {
  macArmPlain: 'a'.repeat(64),
  macArmStrip: 'b'.repeat(64),
  macX64: 'c'.repeat(64),
  lin: 'd'.repeat(64),
  linArm: 'e'.repeat(64),
  win: 'f'.repeat(64),
  winArm: '1'.repeat(64),
  old: '2'.repeat(64),
  rc: '3'.repeat(64),
  fallback: '4'.repeat(64),
};

function asset(name: string, sha: string): string {
  return `${sha}  ${name}`;
}

function name(version: string, triple: string, stripped = true): string {
  const kind = stripped ? 'install_only_stripped' : 'install_only';
  return `cpython-${version}+${TAG}-${triple}-${kind}.tar.gz`;
}

const SUMS = [
  asset(name('3.13.1', 'aarch64-apple-darwin', false), SHA.macArmPlain),
  asset(name('3.13.1', 'aarch64-apple-darwin'), SHA.macArmStrip),
  asset(name('3.12.7', 'aarch64-apple-darwin'), SHA.old),
  asset(name('3.14.0rc2', 'aarch64-apple-darwin'), SHA.rc),
  asset(name('3.13.1', 'x86_64-apple-darwin'), SHA.macX64),
  asset(name('3.13.1', 'aarch64-unknown-linux-gnu'), SHA.linArm),
  asset(name('3.13.1', 'x86_64-unknown-linux-gnu'), SHA.lin),
  asset(name('3.10.16', 'x86_64-unknown-linux-gnu', false), SHA.fallback),
  asset(name('3.13.1', 'x86_64-pc-windows-msvc'), SHA.win),
  asset(name('3.13.1', 'aarch64-pc-windows-msvc'), SHA.winArm),
  asset(name('3.13.1', 'x86_64_v3-unknown-linux-gnu'), '5'.repeat(64)),
  asset(name('3.13.1', 'x86_64-unknown-linux-musl'), '6'.repeat(64)),
  asset(`cpython-3.13.1+${TAG}-x86_64-unknown-linux-gnu-freethreaded-install_only_stripped.tar.gz`, '7'.repeat(64)),
  asset(`cpython-3.13.1+${TAG}-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst`, '8'.repeat(64)),
].join('\n');

const LATEST_JSON = JSON.stringify({
  version: 1,
  tag: TAG,
  asset_url_prefix: PREFIX,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsePythonSums', () => {
  const files = parsePythonSums(SUMS);

  it('keeps baseline install_only archives and drops the other variants', () => {
    const names = files.map((f) => f.filename);
    expect(names).toContain(name('3.13.1', 'aarch64-apple-darwin'));
    expect(names).toContain(name('3.13.1', 'aarch64-apple-darwin', false));
    expect(names).toContain(name('3.14.0rc2', 'aarch64-apple-darwin'));
    expect(names).toContain(name('3.10.16', 'x86_64-unknown-linux-gnu', false));
    expect(names.some((n) => n.includes('x86_64_v3'))).toBe(false);
    expect(names.some((n) => n.includes('musl'))).toBe(false);
    expect(names.some((n) => n.includes('freethreaded'))).toBe(false);
    expect(names.some((n) => n.endsWith('.tar.zst'))).toBe(false);
    expect(files.find((f) => f.filename === name('3.14.0rc2', 'aarch64-apple-darwin'))?.version.extra).toBe('rc2');
  });

  it('accepts a sha256sum binary-mode asterisk', () => {
    const text = `${'a'.repeat(64)} *${name('3.12.7', 'aarch64-apple-darwin')}\n`;
    const files = parsePythonSums(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe(name('3.12.7', 'aarch64-apple-darwin'));
    expect(files[0]?.sha256).toBe('a'.repeat(64));
  });

  it('prefers the stripped archive when both exist', () => {
    const picked = preferStripped(files).find(
      (f) => f.triple === 'aarch64-apple-darwin' && formatPythonVersion(f.version) === '3.13.1',
    );
    expect(picked?.stripped).toBe(true);
    expect(picked?.sha256).toBe(SHA.macArmStrip);
  });
});

describe('python version pick', () => {
  const files = parsePythonSums(SUMS);
  const mac = preferStripped(files.filter((f) => f.triple === pythonTriple(MAC)));
  const versions = [...new Map(mac.map((f) => [formatPythonVersion(f.version), f.version])).values()].sort((a, b) =>
    compareVersions(b, a),
  );

  it('latest, major, and line stay on stable releases', () => {
    expect(formatPythonVersion(pickPythonVersion(versions, { kind: 'latest' })!)).toBe('3.13.1');
    expect(formatPythonVersion(pickPythonVersion(versions, { kind: 'major', major: 3 })!)).toBe('3.13.1');
    expect(formatPythonVersion(pickPythonVersion(versions, { kind: 'line', major: 3, minor: 12 })!)).toBe('3.12.7');
    expect(formatPythonVersion(pickPythonVersion(versions, { kind: 'full', version: '3.14.0rc2' })!)).toBe(
      '3.14.0rc2',
    );
    expect(pickPythonVersion(versions, { kind: 'full', version: '3.14.0' })).toBeUndefined();
  });

  it('latest ignores input order and does not treat a prerelease as newest', () => {
    const versions = files.map((f) => f.version);
    expect(formatPythonVersion(pickPythonVersion(versions, { kind: 'latest' })!)).toBe('3.13.1');
    const final = parsePythonVersion('cpython', '3.14.0');
    const rc = parsePythonVersion('cpython', '3.14.0rc2');
    expect(comparePythonVersions(final, rc)).toBeGreaterThan(0);
    expect(formatPythonVersion(pickPythonVersion([rc, final], { kind: 'latest' })!)).toBe('3.14.0');
    expect(formatPythonVersion(pickPythonVersion([rc, final], { kind: 'line', major: 3, minor: 14 })!)).toBe('3.14.0');
  });

  it('lists stable minor lines for the platform and skips a prerelease-only line', () => {
    const lines = pythonReleaseLines(files, MAC);
    expect(lines.map((l) => l.key)).toEqual(['3.13', '3.12']);
    expect(lines.find((l) => l.key === '3.13')?.latestFullVersion).toBe('3.13.1');
    expect(lines.every((l) => !l.lts)).toBe(true);
    expect(pythonReleaseLines(files, LIN).map((l) => l.key)).toEqual(['3.13', '3.10']);
  });
});

describe('cpython vendor', () => {
  function stubRelease(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith('latest-release.json')) return new Response(LATEST_JSON, { status: 200 });
        if (href === `${PREFIX}/SHA256SUMS`) return new Response(SUMS, { status: 200 });
        throw new Error(`unexpected ${href}`);
      }),
    );
  }

  it('resolve latest picks the newest stable stripped archive for each triple', async () => {
    stubRelease();
    const cases: Array<[{ os: 'mac' | 'linux' | 'windows'; arch: 'aarch64' | 'x64' }, string, string]> = [
      [MAC, 'aarch64-apple-darwin', SHA.macArmStrip],
      [MAC_X64, 'x86_64-apple-darwin', SHA.macX64],
      [LIN_ARM, 'aarch64-unknown-linux-gnu', SHA.linArm],
      [LIN, 'x86_64-unknown-linux-gnu', SHA.lin],
      [WIN, 'x86_64-pc-windows-msvc', SHA.win],
      [WIN_ARM, 'aarch64-pc-windows-msvc', SHA.winArm],
    ];
    for (const [platform, triple, sha] of cases) {
      const artifact = await cpythonVendor.resolve({ kind: 'latest' }, platform);
      expect(artifact.dirName).toBe('cpython-3.13.1');
      expect(artifact.archive).toBe('tar.gz');
      expect(artifact.downloadUrl).toBe(`${PREFIX}/${name('3.13.1', triple)}`);
      expect(artifact.checksum).toEqual({ kind: 'sha256', expected: sha });
    }
  });

  it('resolve major, line, exact, and prerelease', async () => {
    stubRelease();
    const major = await cpythonVendor.resolve({ kind: 'major', major: 3 }, MAC);
    expect(major.dirName).toBe('cpython-3.13.1');
    const line = await cpythonVendor.resolve({ kind: 'line', major: 3, minor: 12 }, MAC);
    expect(line.dirName).toBe('cpython-3.12.7');
    const exact = await cpythonVendor.resolve({ kind: 'full', version: '3.12.7' }, MAC);
    expect(exact.downloadUrl).toContain(name('3.12.7', 'aarch64-apple-darwin'));
    const pre = await cpythonVendor.resolve({ kind: 'full', version: '3.14.0rc2' }, MAC);
    expect(pre.dirName).toBe('cpython-3.14.0rc2');
    expect(pre.checksum?.expected).toBe(SHA.rc);
  });

  it('falls back to install_only when the stripped archive is missing', async () => {
    stubRelease();
    const old = await cpythonVendor.resolve({ kind: 'full', version: '3.10.16' }, LIN);
    expect(old.downloadUrl).toContain(name('3.10.16', 'x86_64-unknown-linux-gnu', false));
    expect(old.downloadUrl).not.toContain('install_only_stripped');
    expect(old.checksum?.expected).toBe(SHA.fallback);
  });

  it('says when a release exists only on another platform', async () => {
    stubRelease();
    await expect(cpythonVendor.resolve({ kind: 'full', version: '3.10.16' }, MAC)).rejects.toThrow(/mac\/aarch64/);
    await expect(cpythonVendor.resolve({ kind: 'line', major: 3, minor: 11 }, MAC)).rejects.toThrow(/No Python release/);
  });

  it('rejects an index that is not a build list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith('latest-release.json')) return new Response('{}', { status: 200 });
        throw new Error(`unexpected ${href}`);
      }),
    );
    await expect(cpythonVendor.resolve({ kind: 'latest' }, MAC)).rejects.toThrow(/download prefix/);
  });

  it('rejects a checksum list with no baseline archive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith('latest-release.json')) return new Response(LATEST_JSON, { status: 200 });
        if (href.endsWith('/SHA256SUMS')) return new Response('not a sums file\n', { status: 200 });
        throw new Error(`unexpected ${href}`);
      }),
    );
    await expect(cpythonVendor.resolve({ kind: 'latest' }, MAC)).rejects.toThrow(/no installable builds/);
  });
});

describe('python sdk layout', () => {
  it('points Unix at bin/python3 and Windows at python.exe plus Scripts', () => {
    expect(pythonSdk.envVar).toBe('PYTHON_HOME');
    expect(pythonSdk.binRelPath(MAC)).toBe('bin/python3');
    expect(pythonSdk.envBinSuffix(MAC)).toBe('/bin');
    expect(pythonSdk.binRelPath(WIN)).toBe('python.exe');
    expect(pythonSdk.envPathSuffixes?.(WIN)).toEqual(['', '\\Scripts']);
    expect(pythonSdk.matchesLoose?.(parsePythonVersion('cpython', '3.14.0rc2'))).toBe(false);
    expect(pythonSdk.matchesLoose?.(parsePythonVersion('cpython', '3.13.1'))).toBe(true);
  });
});

describe('full 规格回退历史 release 标签', () => {
  const OLD_TAG = '20250301';
  const oldPrefix = `${CPYTHON_DOWNLOAD_PREFIX}/${OLD_TAG}`;
  const OLD_NAME = `cpython-3.11.9+${OLD_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz`;
  const OLD_SUMS = [asset(OLD_NAME, SHA.old)].join('\n');

  function stubWithHistory(apiTags: string[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith('latest-release.json')) return new Response(LATEST_JSON, { status: 200 });
        if (u === `${PREFIX}/SHA256SUMS`) return new Response(SUMS, { status: 200 });
        if (u.startsWith('https://api.github.com/')) return Response.json(apiTags.map((t) => ({ tag_name: t })));
        if (u === `${oldPrefix}/SHA256SUMS`) return new Response(OLD_SUMS, { status: 200 });
        throw new Error(`unexpected ${u}`);
      }),
    );
  }

  it('最新快照缺版本时从最近的历史标签解析', async () => {
    stubWithHistory([OLD_TAG, TAG]);
    const artifact = await cpythonVendor.resolve({ kind: 'full', version: '3.11.9' }, MAC);
    expect(artifact.downloadUrl).toBe(`${oldPrefix}/${OLD_NAME}`);
    expect(artifact.checksum).toEqual({ kind: 'sha256', expected: SHA.old });
  });

  it('历史标签也没有时才报错', async () => {
    stubWithHistory([OLD_TAG]);
    await expect(cpythonVendor.resolve({ kind: 'full', version: '3.9.1' }, MAC)).rejects.toThrow(
      /No Python release matches/,
    );
  });
});
