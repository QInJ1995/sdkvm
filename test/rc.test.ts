import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rcBegin, rcEnd, rcBlock, stripRcBlock, upsertRcContent } from '../src/shell/rc.js';

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
  });
});

describe('rc separator safety', () => {
  it('no backslash separators in any block (shell syntax)', () => {
    for (const t of ['java', 'go', 'flutter', 'node', 'maven', 'miniconda'] as const) {
      expect(rcBlock(t)).not.toMatch(/\\/);
    }
  });
});
