import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractArchive } from '../src/fs/extract.js';
import { assertContained, normalizeExtracted } from '../src/fs/layout.js';
import { SdkvmError } from '../src/util/errors.js';
import type { Platform } from '../src/core/platform.js';

const execFileAsync = promisify(execFile);
const MAC: Platform = { os: 'mac', arch: 'aarch64', rawPlatform: 'darwin', rawArch: 'arm64' };
const LIN: Platform = { os: 'linux', arch: 'x64', rawPlatform: 'linux', rawArch: 'x64' };

let work: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-extract-'));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

async function makeTarGz(setupDir: string, outFile: string): Promise<void> {
  await execFileAsync('tar', ['-czf', outFile, '-C', setupDir, '.']);
}

describe('extract + normalize', () => {
  it('mac bundle layout: javaHome resolves to Contents/Home', async () => {
    const src = path.join(work, 'src-mac');
    fs.mkdirSync(path.join(src, 'jdk-21.0.5', 'Contents', 'Home', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(src, 'jdk-21.0.5', 'Contents', 'Home', 'bin', 'java'), '#!/bin/sh\n');
    const tgz = path.join(work, 'mac.tar.gz');
    await makeTarGz(src, tgz);

    const dest = path.join(work, 'out-mac');
    await extractArchive(tgz, 'tar.gz', dest, MAC);
    const { root, home } = normalizeExtracted(dest, MAC, 'java');
    expect(path.basename(root)).toBe('jdk-21.0.5');
    expect(home.endsWith(path.join('Contents', 'Home'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'bin', 'java'))).toBe(true);
  });

  it('plain linux layout', async () => {
    const src = path.join(work, 'src-lin');
    fs.mkdirSync(path.join(src, 'jdk-21.0.5', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(src, 'jdk-21.0.5', 'bin', 'java'), '#!/bin/sh\n');
    const tgz = path.join(work, 'lin.tar.gz');
    await makeTarGz(src, tgz);

    const dest = path.join(work, 'out-lin');
    await extractArchive(tgz, 'tar.gz', dest, LIN);
    const { home } = normalizeExtracted(dest, LIN, 'java');
    expect(home.endsWith('jdk-21.0.5')).toBe(true);
  });

  it('ignores __MACOSX and a sibling file, and keeps the directory that has the binary', () => {
    const dest = path.join(work, 'out-meta');
    fs.mkdirSync(path.join(dest, 'jdk-21.0.5', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'jdk-21.0.5', 'bin', 'java'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(dest, '__MACOSX'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'release'), 'temurin\n');
    const { root, home } = normalizeExtracted(dest, LIN, 'java');
    expect(path.basename(root)).toBe('jdk-21.0.5');
    expect(home.endsWith('jdk-21.0.5')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('symlink to a directory is not treated as the archive root', () => {
    const dest = path.join(work, 'out-symlink-root');
    const real = path.join(work, 'real-jdk');
    fs.mkdirSync(path.join(real, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(real, 'bin', 'java'), '#!/bin/sh\n');
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(real, path.join(dest, 'jdk'));
    expect(() => normalizeExtracted(dest, LIN, 'java')).toThrow(/bin not found/);
    expect(fs.existsSync(path.join(real, 'bin', 'java'))).toBe(true);
  });

  it('invalid archive (no bin/java) throws SdkvmError', async () => {
    const src = path.join(work, 'src-bad');
    fs.mkdirSync(path.join(src, 'some-dir'), { recursive: true });
    fs.writeFileSync(path.join(src, 'some-dir', 'readme.txt'), 'hi');
    const tgz = path.join(work, 'bad.tar.gz');
    await makeTarGz(src, tgz);

    const dest = path.join(work, 'out-bad');
    await extractArchive(tgz, 'tar.gz', dest, MAC);
    expect(() => normalizeExtracted(dest, MAC, 'java')).toThrow(SdkvmError);
  });
});

describe('assertContained', () => {
  it('accepts a normal tree', () => {
    const dir = path.join(work, 'ok-tree');
    fs.mkdirSync(path.join(dir, 'jdk', 'bin'), { recursive: true });
    expect(() => assertContained(dir, path.join(dir, 'jdk'))).not.toThrow();
  });

  it('rejects a root outside destDir', () => {
    expect(() => assertContained(path.join(work, 'a'), path.join(work, 'b'))).toThrow(
      /outside the extraction directory/,
    );
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks pointing outside', () => {
    const dir = path.join(work, 'bad-tree');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'escape'));
    expect(() => assertContained(dir, dir)).toThrow(/symlink points outside/);
  });
});

describe('assertContained 符号链接前缀', () => {
  it('接受位于符号链接目录下的解压根与包内相对链接（macOS /tmp 回归）', () => {
    const real = path.join(work, 'real-extract');
    const inner = path.join(real, 'bundle', 'Home');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(real, 'DISCLAIMER'), 'x');
    fs.symlinkSync(path.join('..', '..', 'DISCLAIMER'), path.join(inner, 'DISCLAIMER'));
    const viaLink = path.join(work, 'link-extract');
    fs.symlinkSync(real, viaLink);
    expect(() => assertContained(viaLink, path.join(viaLink, 'bundle', 'Home'))).not.toThrow();
  });
});

describe('assertContained 悬空符号链接词法基', () => {
  it('包内悬空链接通过，即使解压根路径含符号链接组件（/var → /private/var 回归）', () => {
    // 自造符号链接前缀，避免依赖宿主 tmpdir 的实际拼写
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-lay-real-'));
    const via = path.join(os.tmpdir(), `sdkvm-lay-link-${path.basename(real)}`);
    fs.symlinkSync(real, via);
    try {
      fs.symlinkSync('sub/missing', path.join(via, 'dangling'));
      expect(() => assertContained(via, via)).not.toThrow();
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
      fs.rmSync(via, { force: true });
    }
  });

  it('词法基放行不等于放过真实逃逸：../.. 仍然拒绝', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-esc-real-'));
    const via = path.join(os.tmpdir(), `sdkvm-esc-link-${path.basename(real)}`);
    fs.symlinkSync(real, via);
    try {
      fs.symlinkSync('../../outside', path.join(via, 'esc'));
      expect(() => assertContained(via, via)).toThrow(/symlink points outside/);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
      fs.rmSync(via, { force: true });
    }
  });
});
