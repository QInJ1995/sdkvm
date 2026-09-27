import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mirrorCommand } from '../src/cli/mirror.js';
import {
  availableSiteNamesForType,
  findMirrorSite,
  formatMirrorListLine,
  listMirrorSitesForType,
  matchMirrorSiteName,
  normalizeMirrorUrl,
  siteVendorsForType,
} from '../src/cli/mirror-presets.js';
import { loadConfig } from '../src/core/config.js';
import { SdkvmError } from '../src/util/errors.js';
import { log } from '../src/ui/log.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-mirror-cli-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
  vi.restoreAllMocks();
});

describe('mirror presets', () => {
  it('normalizes trailing slashes and host case, keeps path case', () => {
    expect(normalizeMirrorUrl('https://Mirrors.NJU.edu.cn/adoptium/')).toBe(
      'https://mirrors.nju.edu.cn/adoptium',
    );
    expect(normalizeMirrorUrl('https://Mirrors.tuna.tsinghua.edu.cn/Adoptium/')).toBe(
      'https://mirrors.tuna.tsinghua.edu.cn/Adoptium',
    );
  });

  it('does not treat adoptium and Adoptium as the same path', () => {
    expect(
      matchMirrorSiteName('java', {
        temurin: 'https://mirrors.tuna.tsinghua.edu.cn/adoptium',
      }),
    ).toBeNull();
    expect(
      matchMirrorSiteName('java', {
        temurin: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium',
      }),
    ).toBe('tuna');
  });

  it('resolves aliases', () => {
    expect(findMirrorSite('tsinghua')?.name).toBe('tuna');
    expect(findMirrorSite('ali')?.name).toBe('aliyun');
    expect(findMirrorSite('NJU')?.name).toBe('nju');
  });

  it('filters sites by SDK type coverage', () => {
    const java = listMirrorSitesForType('java').map((s) => s.name);
    expect(java).toEqual(['nju', 'tuna', 'official']);

    const go = listMirrorSitesForType('go').map((s) => s.name);
    expect(go).toEqual(['nju', 'aliyun', 'official']);

    const flutter = listMirrorSitesForType('flutter').map((s) => s.name);
    expect(flutter).toEqual(['nju', 'tuna', 'official']);

    const node = listMirrorSitesForType('node').map((s) => s.name);
    expect(node).toEqual(['nju', 'aliyun', 'huawei', 'official']);

    const maven = listMirrorSitesForType('maven').map((s) => s.name);
    expect(maven).toEqual(['aliyun', 'huawei', 'official']);

    const miniconda = listMirrorSitesForType('miniconda').map((s) => s.name);
    expect(miniconda).toEqual(['nju', 'tuna', 'ustc', 'official']);
  });

  it('scopes vendor URLs per type', () => {
    const nju = findMirrorSite('nju')!;
    expect(siteVendorsForType(nju, 'go')).toEqual({
      golang: 'https://mirror.nju.edu.cn/golang',
    });
    expect(siteVendorsForType(nju, 'java')).toEqual({
      temurin: 'https://mirrors.nju.edu.cn/adoptium',
    });
    expect(siteVendorsForType(findMirrorSite('huawei')!, 'java')).toEqual({});
  });

  it('matches site only within type scope', () => {
    expect(matchMirrorSiteName('java', {})).toBe('official');
    expect(
      matchMirrorSiteName('java', { temurin: 'https://mirrors.nju.edu.cn/adoptium' }),
    ).toBe('nju');
    // go still official even if java is set
    expect(
      matchMirrorSiteName('go', { temurin: 'https://mirrors.nju.edu.cn/adoptium' }),
    ).toBe('official');
    expect(
      matchMirrorSiteName('go', {
        temurin: 'https://mirrors.nju.edu.cn/adoptium',
        golang: 'https://mirror.nju.edu.cn/golang',
      }),
    ).toBe('nju');
    expect(matchMirrorSiteName('java', { temurin: 'https://example.com/jdk' })).toBeNull();
  });

  it('formats nrm-style list lines', () => {
    expect(formatMirrorListLine('nju', 'https://mirror.nju.edu.cn/golang', true)).toBe(
      '* nju ---------- https://mirror.nju.edu.cn/golang',
    );
  });
});

describe('mirrorCommand use / ls / current', () => {
  it('use nju on go only writes golang', () => {
    const ok = vi.spyOn(log, 'ok').mockImplementation(() => {});
    mirrorCommand('go', 'use', 'nju', undefined);
    const c = loadConfig();
    expect(c.mirror.golang).toBe('https://mirror.nju.edu.cn/golang');
    expect(c.mirror.temurin).toBeUndefined();
    expect(c.mirror.nodejs).toBeUndefined();
    expect(ok).toHaveBeenCalled();
  });

  it('use on node does not clear go mirror', () => {
    mirrorCommand('go', 'use', 'aliyun', undefined);
    mirrorCommand('node', 'use', 'huawei', undefined);
    const c = loadConfig();
    expect(c.mirror.golang).toBe('https://mirrors.aliyun.com/golang');
    expect(c.mirror.nodejs).toBe('https://repo.huaweicloud.com/nodejs');
  });

  it('use official clears only current type', () => {
    mirrorCommand('go', 'use', 'nju', undefined);
    mirrorCommand('node', 'use', 'nju', undefined);
    mirrorCommand('go', 'use', 'official', undefined);
    const c = loadConfig();
    expect(c.mirror.golang).toBeUndefined();
    expect(c.mirror.nodejs).toBe('https://mirror.nju.edu.cn/nodejs-release');
  });

  it('use huawei on java fails', () => {
    expect(() => mirrorCommand('java', 'use', 'huawei', undefined)).toThrow(SdkvmError);
    expect(() => mirrorCommand('java', 'use', 'huawei', undefined)).toThrow(/huawei/);
  });

  it('use resolves aliases', () => {
    mirrorCommand('flutter', 'use', 'tsinghua', undefined);
    expect(loadConfig().mirror.flutter).toBe(
      'https://mirrors.tuna.tsinghua.edu.cn/flutter/flutter_infra_release',
    );
  });

  it('ls marks current site for type', () => {
    mirrorCommand('go', 'use', 'nju', undefined);
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    mirrorCommand('go', 'ls', undefined, undefined);
    expect(lines.some((l) => l.startsWith('* nju'))).toBe(true);
    expect(availableSiteNamesForType('go')).toContain('official');
  });

  it('ls shows custom when URL is hand-set', () => {
    mirrorCommand('go', 'set', 'golang', 'https://golang.google.cn/dl');
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    mirrorCommand('go', 'ls', undefined, undefined);
    expect(lines.some((l) => l.startsWith('* custom') && l.includes('golang.google.cn'))).toBe(
      true,
    );
  });

  it('use tuna on miniconda writes the installer directory, not a conda channel', () => {
    mirrorCommand('miniconda', 'use', 'tuna', undefined);
    expect(loadConfig().mirror.miniconda).toBe('https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda');
    expect(loadConfig().mirror.miniconda).not.toContain('/pkgs/');
    expect(loadConfig().mirror.nodejs).toBeUndefined();
    expect(() => mirrorCommand('miniconda', 'use', 'aliyun', undefined)).toThrow(/unsupported mirror site/i);
  });

  it('use aliyun on maven writes the Central root', () => {
    mirrorCommand('maven', 'use', 'aliyun', undefined);
    expect(loadConfig().mirror.maven).toBe('https://maven.aliyun.com/repository/central');
    expect(loadConfig().mirror.maven).not.toContain('mirrors.aliyun.com/apache');
    expect(loadConfig().mirror.nodejs).toBeUndefined();
  });

  it('current prints site name', () => {
    mirrorCommand('node', 'use', 'ali', undefined);
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    mirrorCommand('node', 'current', undefined, undefined);
    expect(lines[0]).toMatch(/^aliyun → /);
  });

  it('set trims URL and rejects non-http(s)', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    mirrorCommand('go', 'set', 'golang', '  https://mirrors.aliyun.com/golang/  ');
    expect(loadConfig().mirror.golang).toBe('https://mirrors.aliyun.com/golang');
    expect(() => mirrorCommand('go', 'set', 'golang', 'ftp://example.com/go')).toThrow(/protocol/);
  });

  it('set site name without URL hints to use', () => {
    expect(() => mirrorCommand('go', 'set', 'nju', undefined)).toThrow(/mirror site name/);
    expect(() => mirrorCommand('go', 'unset', 'official', undefined)).toThrow(/mirror use official/);
  });
});
