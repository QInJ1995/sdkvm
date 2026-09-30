import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMrmBlock,
  defaultMavenSettingsPath,
  expandSettingsPath,
  findMavenRegistry,
  mrmAdd,
  mrmCurrent,
  mrmDel,
  mrmLs,
  mrmSettings,
  mrmTest,
  mrmUse,
  MRM_BEGIN,
  MRM_END,
  readMrmUrl,
  resolveSettingsTarget,
} from '../src/cli/mrm.js';
import { loadConfig } from '../src/core/config.js';
import { SdkvmError } from '../src/util/errors.js';
import { log } from '../src/ui/log.js';

const USER_MIRROR = `<settings>
  <mirrors>
    <mirror>
      <id>user</id>
      <url>https://example.com/repo/</url>
    </mirror>
  </mirrors>
  <servers>
    <server><id>keep</id></server>
  </servers>
</settings>
`;

let home: string;
let settingsFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-mrm-'));
  settingsFile = path.join(home, 'settings.xml');
  process.env.SDKVM_HOME = home;
  process.env.SDKVM_M2_SETTINGS = settingsFile;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
  delete process.env.SDKVM_M2_SETTINGS;
  vi.restoreAllMocks();
});

describe('mrm presets', () => {
  it('resolves aliyun public and the ali alias', () => {
    expect(findMavenRegistry('aliyun')?.url).toBe('https://maven.aliyun.com/repository/public/');
    expect(findMavenRegistry('ali')?.name).toBe('aliyun');
    expect(findMavenRegistry('huawei')?.url).toContain('repo.huaweicloud.com/repository/maven/');
    expect(findMavenRegistry('tencent')?.url).toContain('maven-public/');
  });
});

describe('applyMrmBlock', () => {
  it('creates a minimal settings file', () => {
    const xml = applyMrmBlock('', { name: 'aliyun', url: 'https://maven.aliyun.com/repository/public/' });
    expect(xml).toContain('<id>sdkvm</id>');
    expect(xml).toContain('<mirrorOf>*</mirrorOf>');
    expect(xml).toContain('<name>aliyun</name>');
    expect(xml).toContain(MRM_BEGIN);
    expect(xml).toContain('</settings>');
  });

  it('inserts the marker as the first mirror and keeps other mirrors and servers', () => {
    const xml = applyMrmBlock(USER_MIRROR, {
      name: 'aliyun',
      url: 'https://maven.aliyun.com/repository/public/',
    });
    expect(xml.indexOf('<id>sdkvm</id>')).toBeLessThan(xml.indexOf('<id>user</id>'));
    expect(xml).toContain('https://example.com/repo/');
    expect(xml).toContain('<id>keep</id>');
  });

  it('wraps a mirrors element when the file has none', () => {
    const xml = applyMrmBlock(
      '<settings>\n  <servers><server><id>keep</id></server></servers>\n</settings>\n',
      { name: 'huawei', url: 'https://repo.huaweicloud.com/repository/maven/' },
    );
    expect(xml).toContain('<id>keep</id>');
    expect(xml.indexOf('<id>keep</id>')).toBeLessThan(xml.indexOf(MRM_BEGIN));
    expect(xml).toContain('<mirrors>');
  });

  it('official removes only the sdkvm block', () => {
    const withBlock = applyMrmBlock(USER_MIRROR, {
      name: 'aliyun',
      url: 'https://maven.aliyun.com/repository/public/',
    });
    const xml = applyMrmBlock(withBlock, null);
    expect(xml).not.toContain(MRM_BEGIN);
    expect(xml).not.toContain('<id>sdkvm</id>');
    expect(xml).toContain('<id>user</id>');
    expect(xml).toContain('<id>keep</id>');
  });

  it('rejects an unpaired marker and a file without </settings>', () => {
    // 标记独占一行才是边界；行中出现的标记文本属于用户内容，不算不配对
    expect(() => applyMrmBlock(`<settings>\n${MRM_BEGIN}\n</settings>`, null)).toThrow(SdkvmError);
    expect(() => applyMrmBlock('<settings><mirrors></mirrors>', null)).toThrow(/no <\/settings>/);
  });

  it('does not treat a commented mirrors example as the real element', () => {
    const commented = `<settings>
  <!-- mirrors
  <mirrors>
    <mirror>
      <id>mirrorId</id>
      <url>http://my.repository.com/repo/path</url>
    </mirror>
  </mirrors>
   -->
  <profiles><profile><id>keep</id></profile></profiles>
</settings>
`;
    const xml = applyMrmBlock(commented, {
      name: 'aliyun',
      url: 'https://maven.aliyun.com/repository/public/',
    });
    const commentEnd = xml.indexOf('-->');
    expect(xml.indexOf('http://my.repository.com/repo/path')).toBeLessThan(commentEnd);
    expect(xml.indexOf('<id>sdkvm</id>')).toBeGreaterThan(commentEnd);
    expect(xml).toContain('<id>keep</id>');
  });

  it('keeps an opening mirrors tag that has a URL in an attribute', () => {
    const xml = applyMrmBlock(
      '<settings>\n  <mirrors xmlns="http://maven.apache.org/SETTINGS/1.2.0">\n    <mirror><id>user</id></mirror>\n  </mirrors>\n</settings>\n',
      { name: 'aliyun', url: 'https://maven.aliyun.com/repository/public/' },
    );
    expect(xml.match(/<\/mirrors>/g)).toHaveLength(1);
    expect(xml.indexOf('<id>sdkvm</id>')).toBeLessThan(xml.indexOf('<id>user</id>'));
  });

  it('expands a self-closing mirrors tag', () => {
    const xml = applyMrmBlock('<settings>\n  <mirrors />\n</settings>\n', {
      name: 'aliyun',
      url: 'https://maven.aliyun.com/repository/public/',
    });
    expect(xml.indexOf('<id>sdkvm</id>')).toBeLessThan(xml.indexOf('</mirrors>'));
    expect(xml).not.toMatch(/<mirrors\s*\/>/);
  });

  it('ignores </settings> that only appears inside a comment', () => {
    expect(() => applyMrmBlock('<settings>\n  <!-- </settings> -->\n', null)).toThrow(/no <\/settings>/);
  });
});

describe('settings path', () => {
  it('expands ~ and resolves relative paths', () => {
    expect(expandSettingsPath('~/m2/settings.xml')).toBe(path.join(os.homedir(), 'm2', 'settings.xml'));
    expect(expandSettingsPath('settings.xml')).toBe(path.resolve('settings.xml'));
  });

  it('prefers --settings, then env, then config, then the Maven default', () => {
    delete process.env.SDKVM_M2_SETTINGS;
    expect(resolveSettingsTarget()).toEqual({ file: defaultMavenSettingsPath(), source: 'default' });

    const configured = path.join(home, 'configured.xml');
    mrmSettings(configured);
    expect(resolveSettingsTarget()).toEqual({ file: configured, source: 'config' });
    expect(loadConfig().mavenSettings).toBe(configured);
    expect(fs.existsSync(path.dirname(configured))).toBe(true);

    process.env.SDKVM_M2_SETTINGS = settingsFile;
    expect(resolveSettingsTarget().source).toBe('env');

    const flag = path.join(home, 'flag.xml');
    expect(resolveSettingsTarget(flag)).toEqual({ file: flag, source: 'flag' });
  });

  it('stores a relative path as absolute and unset clears config only', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    mrmSettings('settings.xml');
    expect(loadConfig().mavenSettings).toBe(path.resolve('settings.xml'));
    mrmSettings('unset');
    expect(loadConfig().mavenSettings).toBe('');
    expect(process.env.SDKVM_M2_SETTINGS).toBe(settingsFile);
  });
});

describe('mrm use', () => {
  it('writes the aliyun public mirror and does not touch another file', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    const other = path.join(home, 'other.xml');
    fs.writeFileSync(other, USER_MIRROR);
    mrmUse('ali', { settings: other });
    const xml = fs.readFileSync(other, 'utf8');
    expect(xml).toContain('<name>aliyun</name>');
    expect(xml).toContain('https://maven.aliyun.com/repository/public/');
    expect(xml).not.toContain('repository/central');
    expect(xml).toContain('<id>user</id>');
    expect(info.mock.calls.some((c) => String(c[0]).includes(`mvn -s ${other}`))).toBe(true);
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('official deletes the marker and leaves the file otherwise', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    mrmUse('aliyun');
    mrmUse('official');
    const xml = fs.readFileSync(settingsFile, 'utf8');
    expect(xml).not.toContain(MRM_BEGIN);
    expect(xml).toContain('<settings>');
  });

  it('does not rewrite when markers are unpaired', () => {
    const broken = `<settings>\n${MRM_BEGIN}\n</settings>\n`;
    fs.writeFileSync(settingsFile, broken);
    expect(() => mrmUse('aliyun')).toThrow(/unpaired/);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(broken);
  });

  it('END 标记出现在 BEGIN 之前同样拒绝：strip 会吞掉 END 之后的用户配置', () => {
    const inverted = [
      '<settings>',
      '  <mirrors>',
      MRM_END,
      MRM_BEGIN,
      '  </mirrors>',
      '</settings>',
      '',
    ].join('\n');
    fs.writeFileSync(settingsFile, inverted);
    expect(() => mrmUse('aliyun')).toThrow(/unpaired/);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(inverted);
  });

  it('CRLF 的 settings.xml 写回时整体保持 CRLF（不产生 \r\r\n 混行）', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const crlf = USER_MIRROR.replace(/\n/g, '\r\n');
    fs.writeFileSync(settingsFile, crlf, 'utf8');

    mrmUse('aliyun');

    const xml = fs.readFileSync(settingsFile, 'utf8');
    expect(xml).toContain('<name>aliyun</name>');
    // 新块与原有行都是 CRLF；不存在孤立的 LF（\r 之外）或双 \r
    expect(xml).not.toMatch(/(?<!\r)\n/);
    expect(xml).not.toContain('\r\r');
  });
});

// Windows 普通权限创建符号链接需要开发者模式：仅 POSIX 上验证
describe.skipIf(process.platform === 'win32')('mrm settings.xml 符号链接', () => {
  it('写入穿透到链接目标，链接本身不被替换成普通文件', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const real = path.join(home, 'real-settings.xml');
    fs.writeFileSync(real, USER_MIRROR);
    fs.symlinkSync(real, settingsFile);

    mrmUse('aliyun');

    // chezmoi/stow 管理的链接必须还是链接
    expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    const xml = fs.readFileSync(real, 'utf8');
    expect(xml).toContain('<name>aliyun</name>');
    expect(xml).toContain('<id>user</id>');
  });
});

describe('mrm list and custom registries', () => {
  it('marks the mirror from the settings file', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    mrmUse('huawei');
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    mrmCurrent();
    expect(lines.join('\n')).toContain('huawei → https://repo.huaweicloud.com/repository/maven/');
    lines.length = 0;
    mrmLs();
    expect(lines.some((l) => l.startsWith('*') && l.includes('huawei'))).toBe(true);
    expect(lines.some((l) => l.startsWith('*') && l.includes('official'))).toBe(false);
  });

  it('adds and deletes a custom registry, and rejects built-ins and unsafe URLs', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    mrmAdd('myrepo', 'https://example.com/maven');
    expect(loadConfig().mavenRegistries.myrepo).toBe('https://example.com/maven/');
    expect(() => mrmAdd('aliyun', 'https://example.com/maven/')).toThrow(/built-in/);
    expect(() => mrmAdd('corp', 'https://example.com/maven?a=1&b=2')).toThrow(/cannot contain/);
    expect(() => mrmAdd('corp', 'https://user:secret@example.com/maven')).toThrow(/username or password/);
    mrmDel('myrepo');
    expect(loadConfig().mavenRegistries.myrepo).toBeUndefined();
    expect(() => mrmDel('ali')).toThrow(/built-in/);
  });

  it('reports Fetch Error without failing the command', async () => {
    const lines: string[] = [];
    vi.spyOn(log, 'raw').mockImplementation((msg) => {
      lines.push(msg);
    });
    await expect(mrmTest('aliyun', { probe: async () => { throw new Error('HTTP 500'); } })).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('Fetch Error');
    lines.length = 0;
    await mrmTest(undefined, { probe: async () => 12 });
    expect(lines.some((l) => l.includes('12 ms'))).toBe(true);
  });
});

describe('mrm 标记行首锚定', () => {
  it('行中出现的标记注释不当作块边界', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const content = [
      '<settings>',
      `  <!-- 手动管理：${MRM_BEGIN} 这行不是边界 -->`,
      '  <mirrors/>',
      '</settings>',
      '',
    ].join('\n');
    expect(readMrmUrl(content)).toBeNull();
    fs.writeFileSync(settingsFile, content);
    mrmUse('aliyun');
    const xml = fs.readFileSync(settingsFile, 'utf8');
    expect(xml).toContain('手动管理');
    expect(xml).toContain('aliyun');
  });
});

describe('mrm del 当前镜像回退', () => {
  it('删除当前生效的镜像时移除 sdkvm 块（回退官方）', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    mrmAdd('myrepo', 'https://example.com/maven');
    mrmUse('myrepo');
    expect(fs.readFileSync(settingsFile, 'utf8')).toContain('example.com/maven');
    mrmDel('myrepo');
    const xml = fs.readFileSync(settingsFile, 'utf8');
    expect(xml).not.toContain(MRM_BEGIN);
    expect(xml).not.toContain('example.com/maven');
    expect(loadConfig().mavenRegistries.myrepo).toBeUndefined();
  });

  it('删除非当前镜像不动 settings.xml', () => {
    vi.spyOn(log, 'ok').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    mrmAdd('myrepo', 'https://example.com/maven');
    mrmAdd('other', 'https://other.example/maven');
    mrmUse('myrepo');
    const before = fs.readFileSync(settingsFile, 'utf8');
    mrmDel('other');
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(before);
  });
});

describe('writeSettings 保留原文件属性', () => {
  it('keeps the original file mode (0600 stays 0600)', () => {
    fs.writeFileSync(settingsFile, '<settings>\n</settings>\n');
    fs.chmodSync(settingsFile, 0o600);
    mrmUse('aliyun');
    // tmp+rename 默认 0644 会把私有 settings.xml 暴露给同机其它用户
    expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(settingsFile, 'utf8')).toContain('maven.aliyun.com');
  });

  it('writes through a dangling symlink instead of replacing the link', () => {
    const target = path.join(home, 'dotfiles', 'settings.xml');
    fs.symlinkSync(target, settingsFile);
    mrmUse('aliyun');
    // 链接本身还是链接（chezmoi/stow 管理不脱钩），内容写进了链接目标
    expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('maven.aliyun.com');
  });

  it('LF-majority mixed-EOL file is not wholesale flipped to CRLF', () => {
    fs.writeFileSync(settingsFile, '<settings>\r\n<a>\n<b>\n<c>\n</settings>\n');
    mrmUse('aliyun');
    const out = fs.readFileSync(settingsFile, 'utf8');
    // 多数派是 LF：原先"出现过 CRLF 就整体翻 CRLF"会让 LF 行全部漂移
    expect(out.includes('\r\n<a>')).toBe(false);
    expect(out).toContain('maven.aliyun.com');
  });

  it('CRLF-majority file keeps the CRLF style', () => {
    fs.writeFileSync(settingsFile, '<settings>\r\n<a>\r\n<b>\r\n</settings>\r\n');
    mrmUse('aliyun');
    const out = fs.readFileSync(settingsFile, 'utf8');
    expect((out.match(/\r\n/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('mrm add 输入校验', () => {
  it('rejects query strings and fragments in repository URLs', () => {
    expect(() => mrmAdd('corp', 'https://x.com/maven?token=1')).toThrow(/query string or fragment/);
    expect(() => mrmAdd('corp', 'https://x.com/maven#frag')).toThrow(/query string or fragment/);
  });
});
