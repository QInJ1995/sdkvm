import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findRegistryByName,
  formatNrmListLine,
  matchListedRegistryName,
  normalizeRegistryUrl,
  nrmAdd,
  nrmCurrent,
  nrmDel,
  nrmLs,
  nrmTest,
  nrmUse,
} from '../src/cli/nrm.js';
import { loadConfig } from '../src/core/config.js';
import { npmCliPath, run } from '../src/util/spawn.js';
import { SdkvmError } from '../src/util/errors.js';
import { log } from '../src/ui/log.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-nrm-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
  vi.restoreAllMocks();
});

describe('npmExec helpers', () => {
  it('locates npm-cli.js next to the node executable', () => {
    const node = path.join('C:', 'Program Files', 'nodejs', 'node.exe');
    expect(npmCliPath(node)).toBe(
      path.join('C:', 'Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  });
});

describe('nrm presets', () => {
  it('normalizes trailing slashes and case', () => {
    expect(normalizeRegistryUrl('https://Registry.npmjs.org/')).toBe('https://registry.npmjs.org');
  });

  it('resolves taobao and npmmirror alias to the same URL', () => {
    expect(findRegistryByName('taobao')?.url).toBe('https://registry.npmmirror.com/');
    expect(findRegistryByName('npmmirror')?.url).toBe('https://registry.npmmirror.com/');
    expect(findRegistryByName('TAOBAO')?.name).toBe('taobao');
  });

  it('matches listed preset by URL', () => {
    expect(matchListedRegistryName('https://registry.npmmirror.com')).toBe('taobao');
    expect(matchListedRegistryName('https://registry.npmjs.org/')).toBe('npm');
    expect(matchListedRegistryName('https://example.com/npm/')).toBeNull();
  });

  it('formats nrm-style list lines', () => {
    expect(formatNrmListLine('npm', 'https://registry.npmjs.org/', false)).toBe(
      '  npm ---------- https://registry.npmjs.org/',
    );
    expect(formatNrmListLine('taobao', 'https://registry.npmmirror.com/', true)).toBe(
      '* taobao ------- https://registry.npmmirror.com/',
    );
  });
});

describe('nrmLs / nrmUse / nrmCurrent', () => {
  it('ls marks the current preset', async () => {
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    const npmRun = vi.fn(async () => ({ stdout: 'https://registry.npmmirror.com/\n', stderr: '' }));
    await nrmLs(npmRun);
    expect(npmRun).toHaveBeenCalledWith(['config', 'get', 'registry']);
    expect(lines.some((l) => l.startsWith('* taobao'))).toBe(true);
    expect(lines.some((l) => l.includes('custom'))).toBe(false);
  });

  it('ls shows custom when registry is unknown', async () => {
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    await nrmLs(async () => ({ stdout: 'https://corp.example/npm/\n', stderr: '' }));
    expect(lines.some((l) => l.startsWith('* custom') && l.includes('https://corp.example/npm/'))).toBe(
      true,
    );
  });

  it('current prints named registry', async () => {
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    await nrmCurrent(async () => ({ stdout: 'https://registry.npmjs.org/\n', stderr: '' }));
    expect(lines[0]).toBe('npm → https://registry.npmjs.org/');
  });

  it('use sets user-level registry', async () => {
    const ok = vi.spyOn(log, 'ok').mockImplementation(() => {});
    const npmRun = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await nrmUse('taobao', npmRun);
    expect(npmRun).toHaveBeenCalledWith([
      'config',
      'set',
      'registry',
      'https://registry.npmmirror.com/',
      '--location=user',
    ]);
    expect(ok).toHaveBeenCalledWith(expect.stringContaining('taobao'));
  });

  it('use rejects unknown names', async () => {
    await expect(nrmUse('nope', async () => ({ stdout: '', stderr: '' }))).rejects.toBeInstanceOf(
      SdkvmError,
    );
    await expect(nrmUse('nope', async () => ({ stdout: '', stderr: '' }))).rejects.toThrow(
      /Unknown registry/,
    );
  });
});

describe('nrm add / del', () => {
  it('add persists custom registry and use can select it', async () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    nrmAdd('myprivate', 'http://xxx/registry');
    expect(loadConfig().npmRegistries.myprivate).toBe('http://xxx/registry/');
    expect(findRegistryByName('myprivate')?.url).toBe('http://xxx/registry/');

    const npmRun = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await nrmUse('myprivate', npmRun);
    expect(npmRun).toHaveBeenCalledWith([
      'config',
      'set',
      'registry',
      'http://xxx/registry/',
      '--location=user',
    ]);
  });

  it('ls includes custom registries', async () => {
    nrmAdd('myprivate', 'http://xxx/registry');
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    await nrmLs(async () => ({ stdout: 'http://xxx/registry/\n', stderr: '' }));
    expect(lines.some((l) => l.startsWith('* myprivate') && l.includes('http://xxx/registry/'))).toBe(
      true,
    );
  });

  it('add rejects built-in names and bad URLs', () => {
    expect(() => nrmAdd('taobao', 'http://xxx/registry')).toThrow(/built-in/);
    expect(() => nrmAdd('1bad', 'http://xxx/registry')).toThrow(/Invalid registry name/);
    expect(() => nrmAdd('ok', 'not-a-url')).toThrow(/Invalid URL/);
  });

  it('add preserves query string and trims whitespace', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    nrmAdd('corp', '  http://xxx/registry?token=1  ');
    expect(loadConfig().npmRegistries.corp).toBe('http://xxx/registry/?token=1');
  });

  it('add updates same name ignoring case without duplicating keys', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    nrmAdd('MyPrivate', 'http://xxx/a');
    nrmAdd('myprivate', 'http://xxx/b');
    const regs = loadConfig().npmRegistries;
    expect(Object.keys(regs).filter((k) => k.toLowerCase() === 'myprivate')).toEqual(['myprivate']);
    expect(regs.myprivate).toBe('http://xxx/b/');
  });

  it('add rejects ftp protocol', () => {
    expect(() => nrmAdd('ok', 'ftp://xxx/registry')).toThrow(/protocol/);
  });
});

describe('nrm test', () => {
  it('prints latency for all listed registries', async () => {
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    const probe = vi.fn(async (url: string) => (url.includes('npmmirror') ? 42 : 100));
    await nrmTest(undefined, {
      npmRun: async () => ({ stdout: 'https://registry.npmmirror.com/\n', stderr: '' }),
      probe,
    });
    expect(probe.mock.calls.length).toBeGreaterThan(3);
    expect(lines.some((l) => l.startsWith('* taobao') && l.includes('42 ms'))).toBe(true);
  });

  it('tests a single registry and reports fetch errors', async () => {
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    await nrmTest('npm', {
      npmRun: async () => ({ stdout: 'https://registry.npmjs.org/\n', stderr: '' }),
      probe: async () => {
        throw new Error('timeout');
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Fetch Error');
    expect(lines[0]).toContain('npm');
  });
});

describe('nrm del 当前源回退', () => {
  it('删除当前使用中的源时回退官方 npm 并警告', async () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    nrmAdd('gone', 'http://xxx/gone');
    const calls: string[][] = [];
    const npmRun = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'get') return { stdout: 'http://xxx/gone/\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await nrmDel('gone', npmRun);
    expect(loadConfig().npmRegistries.gone).toBeUndefined();
    const set = calls.find((c) => c[0] === 'config' && c[1] === 'set');
    expect(set?.[3]).toBe('https://registry.npmjs.org/');
  });

  it('删除非当前源时不改 npm 配置', async () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    nrmAdd('other', 'http://xxx/other');
    const npmRun = vi.fn(async (args: string[]) =>
      args[1] === 'get' ? { stdout: 'https://registry.npmjs.org/\n', stderr: '' } : { stdout: '', stderr: '' },
    );
    await nrmDel('other', npmRun);
    expect(npmRun.mock.calls.filter((c) => c[0][1] === 'set')).toHaveLength(0);
  });

  it('npm 不可用时删除仍完成，仅警告回退失败', async () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    nrmAdd('gone2', 'http://xxx/gone2');
    const npmRun = vi.fn(async () => {
      throw new Error('npm missing');
    });
    await expect(nrmDel('gone2', npmRun)).resolves.toBeUndefined();
    expect(loadConfig().npmRegistries.gone2).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('could not reset'))).toBe(true);
  });
});

describe('run() 的失败分类（cause 保留）', () => {
  it('启动失败（ENOENT）的 cause.code 是 errno 字符串', async () => {
    const err = (await run('sdkvm-no-such-cmd-xyz', ['--version']).catch((e: unknown) => e)) as SdkvmError;
    expect(err).toBeInstanceOf(SdkvmError);
    expect(err.message).toMatch(/Failed to run sdkvm-no-such-cmd-xyz/);
    expect((err.cause as { code?: unknown } | undefined)?.code).toBe('ENOENT');
  });

  it('进程非零退出的 cause.code 是退出码数字，stderr 进消息', async () => {
    const err = (await run(process.execPath, ['-e', 'console.error("boom"); process.exit(7)']).catch(
      (e: unknown) => e,
    )) as SdkvmError;
    expect(err.message).toMatch(/Failed to run .+: boom/);
    expect((err.cause as { code?: unknown } | undefined)?.code).toBe(7);
  });
});

describe('defaultNpmRunner 不把 npm 运行失败误报成未安装', () => {
  // resetModules 后 nrm.js 重新求值其依赖图，errors.js 也是新实例——
  // mock 的 run() 必须用同一次注册表里的 SdkvmError 构造，instanceof 才成立
  async function freshNpmRunner(throwWhat: (Fresh: new (m: string, o?: object) => Error) => Promise<never>) {
    vi.doMock('../src/util/spawn.js', () => ({
      npmExec: () => ({ cmd: 'npm', prefixArgs: [] }),
      npmCliPath: (p: string) => p,
      run: () => throwWhat(FreshSdkvmError),
    }));
    vi.resetModules();
    const { SdkvmError: FreshSdkvmError } = await import('../src/util/errors.js');
    const { defaultNpmRunner } = await import('../src/cli/nrm.js');
    return defaultNpmRunner;
  }

  afterEach(() => {
    vi.doUnmock('../src/util/spawn.js');
    vi.resetModules();
  });

  it('npm 自身非零退出（只读 .npmrc 等）原样上抛', async () => {
    const runner = await freshNpmRunner(async (Fresh) => {
      throw new Fresh('Failed to run npm: EACCES: permission denied, open ~/.npmrc', {
        cause: { code: 254, stderr: 'EACCES: permission denied, open ~/.npmrc' },
      });
    });
    const err = (await runner(['config', 'set', 'registry', 'x']).catch((e: unknown) => e)) as SdkvmError;
    // 关键：不再重标成 "npm is not available"，排障方向是 npm 自身的失败原因
    expect(err.message).toMatch(/Failed to run npm: EACCES/);
  });

  it('启动失败（ENOENT）仍给安装引导提示', async () => {
    const runner = await freshNpmRunner(async (Fresh) => {
      throw new Fresh('Failed to run npm: spawn npm ENOENT', { cause: { code: 'ENOENT' } });
    });
    const err = (await runner(['config', 'get', 'registry']).catch((e: unknown) => e)) as SdkvmError;
    expect(err.message).toBe('npm is not available');
    expect(String(err.hint)).toMatch(/Check your Node.js\/npm installation/);
  });

  it('无 cause 的失败（如超时）也原样上抛', async () => {
    const runner = await freshNpmRunner(async (Fresh) => {
      throw new Fresh('Failed to run npm: timed out after 5s');
    });
    await expect(runner(['config', 'get', 'registry'])).rejects.toThrow(/timed out/);
  });
});
