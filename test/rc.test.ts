import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  rcBegin,
  rcEnd,
  rcBlock,
  rcBlockFish,
  removeRcBlockFromFile,
  stripRcBlock,
  upsertRcContent,
  upsertRcFile,
} from '../src/shell/rc.js';
import { detectPlatform } from '../src/core/platform.js';
import { getSdkType } from '../src/sdk/index.js';

/** 避免宿主环境的 SDKVM_HOME（如 /Volumes/Develop/sdkvm）干扰默认路径断言 */
let savedSdkvmHome: string | undefined;

beforeEach(() => {
  savedSdkvmHome = process.env.SDKVM_HOME;
  delete process.env.SDKVM_HOME;
});

afterEach(() => {
  if (savedSdkvmHome === undefined) {
    delete process.env.SDKVM_HOME;
  } else {
    process.env.SDKVM_HOME = savedSdkvmHome;
  }
});

describe('rc block', () => {
  it('appends to empty content', () => {
    const out = upsertRcContent('', 'java');
    expect(out).toContain(rcBegin('java'));
    expect(out).toContain(rcEnd('java'));
    expect(out).toContain('export JAVA_HOME="$HOME/.sdkvm/current-java"');
  });

  it('idempotent: exactly one block after two upserts', () => {
    const once = upsertRcContent('export FOO=1\n', 'java');
    const twice = upsertRcContent(once, 'java');
    expect(twice.split(rcBegin('java')).length - 1).toBe(1);
    expect(twice.split(rcEnd('java')).length - 1).toBe(1);
    expect(twice).toContain('export FOO=1');
  });

  it('strip removes block and restores original', () => {
    const original = 'export A=1\n\nexport B=2\n';
    const withBlock = upsertRcContent(original, 'java');
    const stripped = stripRcBlock(withBlock, 'java').replace(/\s+$/, '') + '\n';
    expect(stripped).toBe(original);
  });

  it('path guard present', () => {
    expect(rcBlock('java')).toContain('case ":$PATH:"');
  });

  it('go block exports GO_HOME', () => {
    const block = rcBlock('go');
    expect(block).toContain('GO_HOME=');
    expect(block).toContain('current-go');
    expect(block).toContain('case ":$PATH:"');
  });

  it('root outside home falls back to absolute path', () => {
    process.env.SDKVM_HOME = '/opt/custom-root';
    const block = rcBlock('go');
    expect(block).toContain('"/opt/custom-root/current-go"');
    expect(block).not.toContain('$HOME/../');
  });
});

describe('flutter rc block', () => {
  it('exports FLUTTER_HOME pointing at current-flutter', () => {
    const block = rcBlock('flutter');
    expect(block).toContain('FLUTTER_HOME=');
    expect(block).toContain('current-flutter');
    expect(block).toContain('case ":$PATH:"');
  });

  it('java / go / flutter blocks coexist independently', () => {
    let content = upsertRcContent('export A=1\n', 'java');
    content = upsertRcContent(content, 'flutter');
    expect(content).toContain(rcBegin('java'));
    expect(content).toContain('current-flutter');
    expect(content).toContain('export A=1');
  });
});

describe('node rc block', () => {
  it('exports NODE_HOME pointing at current-node', () => {
    const block = rcBlock('node');
    expect(block).toContain('NODE_HOME=');
    expect(block).toContain('current-node');
    expect(block).toContain('case ":$PATH:"');
    expect(block).toContain('"$HOME/.sdkvm/current-node"');
  });
});

describe('maven rc block', () => {
  it('exports MAVEN_HOME pointing at current-maven', () => {
    const block = rcBlock('maven');
    expect(block).toContain('MAVEN_HOME=');
    expect(block).toContain('current-maven');
    expect(block).toContain('case ":$PATH:"');
    expect(block).toContain('"$HOME/.sdkvm/current-maven"');
    expect(block).not.toContain('M2_HOME');
  });
});

describe('miniconda rc block', () => {
  it('exports MINICONDA_HOME and sources conda.sh inside the marker', () => {
    const block = rcBlock('miniconda');
    expect(block).toContain('MINICONDA_HOME=');
    expect(block).toContain('current-miniconda');
    expect(block).toContain('"$HOME/.sdkvm/current-miniconda"');
    expect(block).toContain('export CONDA_EXE="$MINICONDA_HOME/bin/conda"');
    expect(block).toContain('export CONDA_PYTHON_EXE="$MINICONDA_HOME/bin/python"');
    const exe = block.indexOf('export CONDA_EXE=');
    const source = block.indexOf('. "$MINICONDA_HOME/etc/profile.d/conda.sh"');
    expect(exe).toBeGreaterThan(-1);
    expect(source).toBeGreaterThan(exe);
    expect(block.startsWith(rcBegin('miniconda'))).toBe(true);
    expect(block.endsWith(rcEnd('miniconda'))).toBe(true);
  });

  it('does not add the conda hook to other SDKs', () => {
    expect(rcBlock('java')).not.toContain('conda.sh');
    expect(rcBlock('node')).not.toContain('conda.sh');
    expect(rcBlock('maven')).not.toContain('conda.sh');
    expect(rcBlock('python')).not.toContain('conda.sh');
  });
});

describe('python rc block', () => {
  it('exports PYTHON_HOME and prepends bin', () => {
    const block = rcBlock('python');
    // PATH 条目 = envVar + 当前平台的 bin 后缀（Windows 上 python 的可执行文件在根目录，后缀为空）
    const binSuffix = getSdkType('python').envBinSuffix(detectPlatform()).replace(/\\/g, '/');
    expect(block).toContain('PYTHON_HOME=');
    expect(block).toContain('current-python');
    expect(block).toContain('"$HOME/.sdkvm/current-python"');
    expect(block).toContain(`"$PYTHON_HOME${binSuffix}:$PATH"`);
    expect(block).not.toContain('conda.sh');
  });
});

describe('rc separator safety', () => {
  it('no backslash separators in any block (shell syntax)', () => {
    for (const t of ['java', 'go', 'flutter', 'node', 'maven', 'miniconda', 'python'] as const) {
      expect(rcBlock(t)).not.toMatch(/\\/);
    }
  });
});

describe('rc robustness', () => {
  it('strips a block whose end marker was lost (no duplicate after upsert)', () => {
    const broken = `export A=1\n\n${rcBegin('java')}\nexport JAVA_HOME="x"\n`;
    const out = upsertRcContent(broken, 'java');
    expect(out.split(rcBegin('java')).length - 1).toBe(1);
    expect(out).toContain('export A=1');
  });

  it('single-quotes paths containing shell metacharacters', () => {
    process.env.SDKVM_HOME = '/tmp/sdkvm-bad-$path`x';
    try {
      const block = rcBlock('java');
      expect(block).toMatch(/export JAVA_HOME='/);
      expect(block).not.toContain('$HOME');
    } finally {
      delete process.env.SDKVM_HOME;
    }
  });

  it('single-quotes paths containing ! or backslash (history expansion / escape)', () => {
    process.env.SDKVM_HOME = '/tmp/sdk!vm\\x';
    try {
      const block = rcBlock('java');
      expect(block).toMatch(/export JAVA_HOME='/);
      expect(block).not.toContain('export JAVA_HOME="');
      expect(block).toContain('sdk!vm');
    } finally {
      delete process.env.SDKVM_HOME;
    }
  });

  it('removeRcBlockFromFile removes the block from disk', () => {
    const file = path.join(os.tmpdir(), `sdkvm-rc-${process.pid}.rc`);
    fs.writeFileSync(file, upsertRcContent('export A=1\n', 'java'));
    removeRcBlockFromFile(file, 'java');
    const after = fs.readFileSync(file, 'utf8');
    expect(after).not.toContain(rcBegin('java'));
    expect(after).toContain('export A=1');
    fs.rmSync(file, { force: true });
  });

  it('upsertRcFile backs up non-UTF-8 rc content before rewriting', () => {
    const file = path.join(os.tmpdir(), `sdkvm-rc-bin-${process.pid}.rc`);
    fs.writeFileSync(file, Buffer.from('export A=1 # caf\xe9\n', 'latin1'));
    upsertRcFile(file, 'java');
    expect(fs.existsSync(`${file}.sdkvm-bak`)).toBe(true);
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.sdkvm-bak`, { force: true });
  });
});

describe('rc 标记行首锚定', () => {
  it('行中出现的标记文本不当作块边界', () => {
    const B = rcBegin('java');
    const E = rcEnd('java');
    const content = `export A=1\necho "keep ${B} inline" # ${E}\nexport B=2\n`;
    const out = stripRcBlock(content, 'java');
    expect(out).toContain('export A=1');
    expect(out).toContain(`echo "keep ${B} inline"`);
    expect(out).toContain('export B=2');
  });

  it('upsert 在含行中标记文本的文件上保持幂等', () => {
    const B = rcBegin('node');
    const content = `alias z="echo ${B}"\n`;
    const once = upsertRcContent(content, 'node');
    const twice = upsertRcContent(once, 'node');
    const markerLines = (s: string) => s.split('\n').filter((l) => l.trim() === B).length;
    expect(markerLines(once)).toBe(1);
    expect(markerLines(twice)).toBe(1);
    expect(twice).toContain(`alias z="echo ${B}"`);
  });

  it('重复 begin 标记按第一个 end 截断（嵌套内容随块删除）', () => {
    const B = rcBegin('java');
    const E = rcEnd('java');
    const out = stripRcBlock(`export A=1\n${B}\nX\n${B}\nY\n${E}\nexport Z=1\n`, 'java');
    expect(out).toContain('export A=1');
    expect(out).toContain('export Z=1');
    expect(out).not.toMatch(/^Y$/m);
  });

  it('CRLF 文件里的标记行同样识别', () => {
    const B = rcBegin('java');
    const E = rcEnd('java');
    const content = `export A=1\r\n${B}\r\nexport JAVA_HOME="x"\r\n${E}\r\nexport B=2\r\n`;
    const out = stripRcBlock(content, 'java');
    expect(out).toContain('export A=1');
    expect(out).toContain('export B=2');
    expect(out).not.toContain('JAVA_HOME');
  });

  it('未闭合块之后没有其它 sdkvm 标记时，只删标记行、用户内容保留', () => {
    const B = rcBegin('java');
    const content = `export A=1\n${B}\nexport USER_KEEP=1\n`;
    const out = stripRcBlock(content, 'java');
    expect(out).not.toContain(B);
    expect(out).toContain('export A=1');
    expect(out).toContain('export USER_KEEP=1');
  });

  it('未闭合块删到下一个 sdkvm 标记行为止，其它类型的块不受影响', () => {
    const BJ = rcBegin('java');
    const BN = rcBegin('node');
    const EN = rcEnd('node');
    const content = `export A=1\n${BJ}\nexport ORPHAN=1\n${BN}\nexport NODE_HOME="x"\n${EN}\nexport B=2\n`;
    const out = stripRcBlock(content, 'java');
    expect(out).toContain('export A=1');
    expect(out).toContain('export B=2');
    expect(out).not.toContain('export ORPHAN');
    // node 块完整保留
    expect(out).toContain('export NODE_HOME="x"');
    expect(out.split(BN).length - 1).toBe(1);
  });

  it('CRLF 文件 upsert 后块内也保持 CRLF', () => {
    const content = 'export A=1\r\nexport B=2\r\n';
    const out = upsertRcContent(content, 'java');
    expect(out).toContain('export A=1\r\nexport B=2');
    expect(out).toContain(`\r\n${rcBegin('java')}\r\n`);
    expect(out).toContain('\r\nexport JAVA_HOME=');
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('首次创建也走原子写，不留下半截文件或 tmp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-rc-create-'));
    const file = path.join(dir, '.zshrc');
    try {
      upsertRcFile(file, 'java');
      const residue = fs.readdirSync(dir).filter((n) => n.includes('sdkvm-tmp'));
      expect(residue).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toContain(rcBegin('java'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('原子写不残留 tmp 文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-rc-atomic-'));
    const file = path.join(dir, '.zshrc');
    try {
      fs.writeFileSync(file, 'export A=1\n');
      upsertRcFile(file, 'java');
      removeRcBlockFromFile(file, 'java');
      const residue = fs.readdirSync(dir).filter((n) => n.includes('sdkvm-tmp'));
      expect(residue).toEqual([]);
      // remove 会留下块前的分隔空行：只断言标记清除与用户内容保留
      expect(fs.readFileSync(file, 'utf8').trim()).toBe('export A=1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fish 标记块', () => {
  it('fish_add_path 存在时优先用；老版本 fish 退回 contains + set -gx', () => {
    const block = rcBlockFish('java');
    // 3.2+ 的幂等入口
    expect(block).toContain('if type -q fish_add_path');
    expect(block).toContain('fish_add_path -p "$JAVA_HOME/bin"');
    // 老版本回退分支也必须幂等（contains 守卫），且以 end 收尾
    expect(block).toContain('else if not contains "$JAVA_HOME/bin" $PATH');
    expect(block).toContain('set -gx PATH "$JAVA_HOME/bin" $PATH');
    // if/else 以独立的 end 行收尾（rcEnd 标记在块外层）
    expect(block.split('\n')).toContain('end');
    // fish 语法：绝不能混入 bash 的 export / case
    expect(block).not.toContain('export ');
    expect(block).not.toContain('case ');
  });

  it('miniconda 的 fish 块导出 CONDA_EXE 而非 bash 的 source', () => {
    const block = rcBlockFish('miniconda');
    const envVar = getSdkType('miniconda').envVar;
    expect(block).toContain(`set -gx CONDA_EXE "$${envVar}/bin/conda"`);
    expect(block).not.toContain('source ');
  });
});

// Windows 普通权限创建符号链接需要开发者模式：仅 POSIX 上验证
describe.skipIf(process.platform === 'win32')('rc 符号链接', () => {
  it('写入穿透到链接目标，链接本身不被替换成普通文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-rc-link-'));
    try {
      const real = path.join(dir, 'zshrc.real');
      fs.writeFileSync(real, 'export A=1\n');
      const link = path.join(dir, '.zshrc');
      fs.symlinkSync(real, link);

      upsertRcFile(link, 'java');

      // chezmoi/stow 管理的链接必须还是链接，内容写到真实目标
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      const content = fs.readFileSync(real, 'utf8');
      expect(content).toContain('export A=1');
      expect(content).toContain(rcBegin('java'));

      // 删除块同样走链接
      removeRcBlockFromFile(link, 'java');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(real, 'utf8').trim()).toBe('export A=1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
