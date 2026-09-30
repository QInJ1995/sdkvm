import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodejsVendor } from '../src/vendor/nodejs.js';
import { goSdk } from '../src/sdk/go.js';
import { isNodeLtsMajor, nodeSdk } from '../src/sdk/node.js';

const MAC = { os: 'mac' as const, arch: 'aarch64' as const };
const LIN = { os: 'linux' as const, arch: 'x64' as const };
const WIN = { os: 'windows' as const, arch: 'x64' as const };

const X = 'a'.repeat(64);
const Y = 'b'.repeat(64);
const Z = 'c'.repeat(64);

const INDEX = [
  { version: 'v26.1.0', lts: false },
  { version: 'v24.2.0', lts: 'Krypton' },
  { version: 'v24.1.0', lts: 'Krypton' },
  { version: 'v22.3.1', lts: 'Jod' },
  { version: 'v20.1.0', lts: false },
];

function shasums(v: string): string {
  return [
    `${X} *node-${v}-darwin-arm64.tar.xz`,
    `${X}  node-${v}-darwin-arm64.tar.gz`,
    `${Y}  node-${v}-linux-x64.tar.xz`,
    `${Y}  node-${v}-linux-x64.tar.gz`,
    `${Z}  node-${v}-win-x64.zip`,
  ].join('\n');
}

function stubNodeApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/index.json')) return Response.json(INDEX);
      const m = /\/(v[\d.]+)\/SHASUMS256\.txt$/.exec(u);
      if (m && m[1]) return new Response(shasums(m[1]));
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nodejs vendor', () => {
  it('latest → newest overall (Current line)', async () => {
    stubNodeApi();
    const a = await nodejsVendor.resolve({ kind: 'latest' }, MAC);
    expect(a.dirName).toBe('nodejs-26.1.0');
    expect(a.displayName).toBe('Node.js 26.1.0');
    expect(a.downloadUrl).toBe('https://nodejs.org/dist/v26.1.0/node-v26.1.0-darwin-arm64.tar.xz');
    expect(a.archive).toBe('tar.xz');
    expect(a.checksum?.expected).toBe(X);
  });

  it('lts → newest entry with lts codename', async () => {
    stubNodeApi();
    const a = await nodejsVendor.resolve({ kind: 'lts' }, MAC);
    expect(a.dirName).toBe('nodejs-24.2.0');
  });

  it('major line 22 → latest of that line', async () => {
    stubNodeApi();
    const a = await nodejsVendor.resolve({ kind: 'major', major: 22 }, MAC);
    expect(a.dirName).toBe('nodejs-22.3.1');
  });

  it('full exact match, not newest of line', async () => {
    stubNodeApi();
    const a = await nodejsVendor.resolve({ kind: 'full', version: '24.1.0' }, MAC);
    expect(a.dirName).toBe('nodejs-24.1.0');
  });

  it('prefers .tar.xz over .tar.gz when both exist', async () => {
    stubNodeApi();
    const a = await nodejsVendor.resolve({ kind: 'latest' }, LIN);
    expect(a.downloadUrl).toBe('https://nodejs.org/dist/v26.1.0/node-v26.1.0-linux-x64.tar.xz');
    expect(a.checksum?.expected).toBe(Y);
  });

  it('windows uses root-level zip', async () => {
    stubNodeApi();
    const a = await nodejsVendor.resolve({ kind: 'latest' }, WIN);
    expect(a.archive).toBe('zip');
    expect(a.downloadUrl).toBe('https://nodejs.org/dist/v26.1.0/node-v26.1.0-win-x64.zip');
    expect(a.checksum?.expected).toBe(Z);
  });

  it('platform without archive throws with hint', async () => {
    stubNodeApi();
    await expect(
      nodejsVendor.resolve({ kind: 'latest' }, { os: 'linux', arch: 'aarch64' }),
    ).rejects.toThrow(/No Node\.js 26\.1\.0 archive for linux\/aarch64/);
  });

  it('unknown line throws with ls -r hint', async () => {
    stubNodeApi();
    await expect(nodejsVendor.resolve({ kind: 'major', major: 99 }, MAC)).rejects.toThrow(
      /No Node\.js release matches "99"/,
    );
  });

  it('listMajors groups by major, lts from newest entry', async () => {
    stubNodeApi();
    expect(await nodejsVendor.listMajors()).toEqual([
      { key: '26', lts: false, latestFullVersion: '26.1.0' },
      { key: '24', lts: true, latestFullVersion: '24.2.0' },
      { key: '22', lts: true, latestFullVersion: '22.3.1' },
      { key: '20', lts: false, latestFullVersion: '20.1.0' },
    ]);
  });

  it('a missing lts field is not treated as LTS (only a codename string is)', async () => {
    // 索引结构变更/字段缺失时，"lts !== false" 会把 Current 当 LTS；只有字符串代号才算
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('/index.json')) {
          return Response.json([
            { version: 'v24.2.0', lts: 'Krypton' },
            { version: 'v22.3.1' }, // lts 字段缺失
          ]);
        }
        const m = /\/(v[\d.]+)\/SHASUMS256\.txt$/.exec(u);
        if (m && m[1]) return new Response(shasums(m[1]));
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const a = await nodejsVendor.resolve({ kind: 'lts' }, MAC);
    expect(a.dirName).toBe('nodejs-24.2.0');
    const lines = await nodejsVendor.listMajors();
    expect(lines.find((l) => l.key === '22')?.lts).toBe(false);
    expect(lines.find((l) => l.key === '24')?.lts).toBe(true);
  });
});

describe('isNodeLtsMajor', () => {
  const september = new Date('2026-09-27T00:00:00Z');
  const october = new Date('2026-10-01T00:00:00Z');

  it('keeps an even major in Current until October of its release year', () => {
    expect(isNodeLtsMajor(26, september)).toBe(false);
    expect(isNodeLtsMajor(26, october)).toBe(true);
    expect(isNodeLtsMajor(24, september)).toBe(true);
    expect(isNodeLtsMajor(23, september)).toBe(false);
    expect(isNodeLtsMajor(21, october)).toBe(false);
  });
});

describe('node bin layout', () => {
  it('binRelPath: windows root exe, unix bin/', () => {
    expect(nodeSdk.binRelPath(WIN)).toBe('node.exe');
    expect(nodeSdk.binRelPath(MAC)).toBe('bin/node');
  });

  it('envBinSuffix: node has no \\bin on windows; go keeps it', () => {
    expect(nodeSdk.envBinSuffix(WIN)).toBe('');
    expect(nodeSdk.envBinSuffix(MAC)).toBe('/bin');
    expect(goSdk.envBinSuffix(WIN)).toBe('\\bin');
  });
});
