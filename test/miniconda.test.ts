import { afterEach, describe, expect, it, vi } from 'vitest';
import { minicondaReleaseLines, minicondaVendor, parseMinicondaIndex } from '../src/vendor/miniconda.js';
import { assertInstallerPrefix, silentInstallCommand } from '../src/fs/installer.js';
import { SdkvmError } from '../src/util/errors.js';

const MAC = { os: 'mac' as const, arch: 'aarch64' as const };
const MAC_X64 = { os: 'mac' as const, arch: 'x64' as const };
const LIN = { os: 'linux' as const, arch: 'x64' as const };
const WIN = { os: 'windows' as const, arch: 'x64' as const };
const WIN_ARM = { os: 'windows' as const, arch: 'aarch64' as const };

const SHA = {
  py314: '1'.repeat(64),
  py313: '8d0b858358456d4ee159feb0c4ee6d635590b777f8b9ffa4aa7553c469aae2b6',
  py312: '2'.repeat(64),
  linux: '3'.repeat(64),
  win: '4'.repeat(64),
  old: '5'.repeat(64),
  pkg: 'a'.repeat(64),
};

function row(name: string, sha: string): string {
  return `<tr><td><a href="${name}">${name}</a></td><td class="s">150M</td><td>2026-08-28</td><td>${sha}</td></tr>`;
}

const HTML = [
  '<table>',
  row('Miniconda3-latest-MacOSX-arm64.sh', 'b'.repeat(64)),
  row('Miniconda3-py314_26.7.1-1-MacOSX-arm64.sh', SHA.py314),
  row('Miniconda3-py314_26.7.1-1-MacOSX-arm64.pkg', SHA.pkg),
  row('Miniconda3-py313_26.7.1-1-MacOSX-arm64.sh', SHA.py313),
  row('Miniconda3-py312_26.7.1-1-Linux-x86_64.sh', SHA.linux),
  row('Miniconda3-py313_26.7.1-1-Windows-x86_64.exe', SHA.win),
  row('Miniconda3-py39_4.12.0-MacOSX-x86_64.sh', SHA.old),
  row('Miniconda3-4.7.12.1-Linux-x86_64.sh', 'c'.repeat(64)),
  '</table>',
].join('');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseMinicondaIndex', () => {
  it('keeps sh/exe with sha256 and drops latest, pkg, and four-part names', () => {
    const files = parseMinicondaIndex(HTML);
    const names = files.map((f) => f.filename);
    expect(names).toContain('Miniconda3-py313_26.7.1-1-MacOSX-arm64.sh');
    expect(names).not.toContain('Miniconda3-latest-MacOSX-arm64.sh');
    expect(names).not.toContain('Miniconda3-py314_26.7.1-1-MacOSX-arm64.pkg');
    expect(names).not.toContain('Miniconda3-4.7.12.1-Linux-x86_64.sh');
    expect(files.find((f) => f.filename.includes('py313_26.7.1-1-MacOSX'))?.sha256).toBe(SHA.py313);
  });
});

describe('miniconda vendor', () => {
  function stubIndex(): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).startsWith('https://repo.anaconda.com/miniconda')) {
        return new Response(HTML, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }));
  }

  it('resolve latest picks the newest installer and the highest Python', async () => {
    stubIndex();
    const mac = await minicondaVendor.resolve({ kind: 'latest' }, MAC);
    expect(mac.dirName).toBe('miniconda-py314_26.7.1-1');
    expect(mac.downloadUrl).toBe(
      'https://repo.anaconda.com/miniconda/Miniconda3-py314_26.7.1-1-MacOSX-arm64.sh',
    );
    expect(mac.archive).toBe('sh');
    expect(mac.checksum).toEqual({ kind: 'sha256', expected: SHA.py314 });

    const linux = await minicondaVendor.resolve({ kind: 'latest' }, LIN);
    expect(linux.downloadUrl).toContain('Miniconda3-py312_26.7.1-1-Linux-x86_64.sh');
  });

  it('resolve major, line, build, and python pin', async () => {
    stubIndex();
    const year = await minicondaVendor.resolve({ kind: 'major', major: 26 }, MAC);
    expect(year.dirName).toBe('miniconda-py314_26.7.1-1');
    const line = await minicondaVendor.resolve({ kind: 'line', major: 26, minor: 7 }, MAC);
    expect(line.dirName).toBe('miniconda-py314_26.7.1-1');
    const build = await minicondaVendor.resolve({ kind: 'full', version: '26.7.1-1' }, MAC);
    expect(build.dirName).toBe('miniconda-py314_26.7.1-1');
    const py = await minicondaVendor.resolve({ kind: 'full', version: 'py313' }, MAC);
    expect(py.dirName).toBe('miniconda-py313_26.7.1-1');
    const exact = await minicondaVendor.resolve({ kind: 'full', version: 'py313_26.7.1-1' }, MAC);
    expect(exact.checksum?.expected).toBe(SHA.py313);
    const win = await minicondaVendor.resolve({ kind: 'full', version: 'py313_26.7.1-1' }, WIN);
    expect(win.archive).toBe('exe');
    expect(win.downloadUrl).toContain('Windows-x86_64.exe');
    const oldMac = await minicondaVendor.resolve({ kind: 'major', major: 4 }, MAC_X64);
    expect(oldMac.dirName).toBe('miniconda-py39_4.12.0');
  });

  it('rejects Windows ARM', async () => {
    stubIndex();
    await expect(minicondaVendor.resolve({ kind: 'latest' }, WIN_ARM)).rejects.toThrow(/windows\/aarch64/);
  });

  it('lists only lines that ship an installer for the platform', () => {
    const files = parseMinicondaIndex(HTML);
    const arm = minicondaReleaseLines(files, MAC);
    expect(arm.find((l) => l.key === '26.7')?.latestFullVersion).toBe('py314_26.7.1-1');
    expect(arm.find((l) => l.key === '4.12')).toBeUndefined();
    const intel = minicondaReleaseLines(files, MAC_X64);
    expect(intel.find((l) => l.key === '4.12')?.latestFullVersion).toBe('py39_4.12.0');
    expect(intel.find((l) => l.key === '26.7')).toBeUndefined();
    expect(arm.some((l) => l.lts)).toBe(false);
    expect(minicondaReleaseLines(files, WIN_ARM)).toEqual([]);
  });

  it('says when a line exists only on another platform', async () => {
    stubIndex();
    await expect(minicondaVendor.resolve({ kind: 'line', major: 26, minor: 7 }, MAC_X64)).rejects.toThrow(
      /mac\/x64/,
    );
  });
});

describe('silent installer command', () => {
  it('unix uses bash -b -p and windows puts /D last without AddToPath', () => {
    const unix = silentInstallCommand('/tmp/Miniconda3.sh', 'sh', '/opt/sdkvm/minicondas/miniconda-py313_26.7.1-1');
    expect(unix).toEqual({
      cmd: 'bash',
      args: ['/tmp/Miniconda3.sh', '-b', '-p', '/opt/sdkvm/minicondas/miniconda-py313_26.7.1-1'],
    });
    const win = silentInstallCommand(
      'C:\\cache\\Miniconda3.exe',
      'exe',
      'C:\\sdkvm\\minicondas\\miniconda-py313_26.7.1-1',
    );
    expect(win.cmd).toBe('C:\\cache\\Miniconda3.exe');
    expect(win.args).toEqual([
      '/InstallationType=JustMe',
      '/AddToPath=0',
      '/RegisterPython=0',
      '/S',
      '/D=C:\\sdkvm\\minicondas\\miniconda-py313_26.7.1-1',
    ]);
    expect(win.args.at(-1)?.startsWith('/D=')).toBe(true);
  });

  it('rejects a Windows prefix that contains spaces before the installer runs', () => {
    expect(() => assertInstallerPrefix('C:\\Users\\Qin Jin\\.sdkvm\\minicondas\\miniconda-py313_26.7.1-1', 'windows')).toThrow(
      SdkvmError,
    );
    expect(() => assertInstallerPrefix('/Users/Qin Jin/.sdkvm/minicondas/miniconda-py313_26.7.1-1', 'mac')).not.toThrow();
  });
});
