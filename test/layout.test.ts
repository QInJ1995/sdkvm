import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
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

function hasCommand(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_UNZIP = hasCommand('unzip', ['-v']);

/** POSIX ustar 头。checksum 字段在求和时按 8 个空格计。 */
function ustarHeader(name: string, size: number, typeflag: string, linkname = ''): Buffer {
  const header = Buffer.alloc(512, 0);
  const nameBuf = Buffer.from(name);
  if (nameBuf.length >= 100) throw new Error(`tar name too long: ${name}`);
  nameBuf.copy(header, 0);
  header.write('0000777\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write(typeflag, 156, 'ascii');
  if (linkname) {
    const link = Buffer.from(linkname);
    if (link.length >= 100) throw new Error(`tar link too long: ${linkname}`);
    link.copy(header, 157);
  }
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i]!;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

function pad512(data: Buffer): Buffer {
  const pad = (512 - (data.length % 512)) % 512;
  return pad === 0 ? data : Buffer.concat([data, Buffer.alloc(pad)]);
}

/** GNU long-link（typeflag K），让符号链接目标超过 ustar 的 100 字节。 */
function gnuLongLink(linkname: string): Buffer[] {
  const data = Buffer.from(`${linkname}\0`);
  return [ustarHeader('././@LongLink', data.length, 'K'), pad512(data)];
}

function tarEntry(name: string, data: Buffer): Buffer[] {
  return [ustarHeader(name, data.length, '0'), pad512(data)];
}

function tarSymlink(name: string, target: string): Buffer[] {
  const long = Buffer.byteLength(target) >= 100 ? gnuLongLink(target) : [];
  const shown = Buffer.byteLength(target) >= 100 ? '' : target;
  return [...long, ustarHeader(name, 0, '2', shown)];
}

function writeTarGz(outFile: string, parts: Buffer[]): void {
  fs.writeFileSync(outFile, gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 无压缩 ZIP，用来放系统 zip 拒绝写入的 `..` 成员。 */
function writeZip(outFile: string, entries: { name: string; data: Buffer }[]): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outFile, Buffer.concat([...locals, centralDir, end]));
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

  it('older Zulu macOS layout: Contents/Home sits inside zulu-*.jdk', () => {
    const dest = path.join(work, 'out-zulu-jdk');
    const homeBin = path.join(
      dest,
      'zulu21.36.17-ca-jdk21.0.4-macosx_aarch64',
      'zulu-21.jdk',
      'Contents',
      'Home',
      'bin',
    );
    fs.mkdirSync(homeBin, { recursive: true });
    fs.writeFileSync(path.join(homeBin, 'java'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dest, 'DISCLAIMER'), 'zulu\n');
    const { root, home } = normalizeExtracted(dest, MAC, 'java');
    expect(path.basename(root)).toBe('zulu21.36.17-ca-jdk21.0.4-macosx_aarch64');
    expect(home.endsWith(path.join('zulu-21.jdk', 'Contents', 'Home'))).toBe(true);
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

describe('extract 路径穿越', () => {
  it('tar 成员名含 .. 时不写出目标目录，安全成员仍在', async () => {
    const tgz = path.join(work, 'slip.tar.gz');
    const payload = Buffer.from('#!/bin/sh\n');
    writeTarGz(tgz, [
      ...tarEntry('../outside.txt', Buffer.from('pwned\n')),
      ...tarEntry('jdk/../../outside2.txt', Buffer.from('pwned\n')),
      ...tarEntry('jdk/bin/java', payload),
    ]);
    const dest = path.join(work, 'out-slip');
    await extractArchive(tgz, 'tar.gz', dest, MAC);
    expect(fs.existsSync(path.join(work, 'outside.txt'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'outside2.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(work), 'outside.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'outside.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'jdk', 'bin', 'java'))).toEqual(payload);
  });

  it.skipIf(process.platform === 'win32')('符号链接成员不会把后续文件写进链接目标', async () => {
    const victim = path.join(work, 'victim-dir');
    fs.mkdirSync(victim);
    const tgz = path.join(work, 'symlink-slip.tar.gz');
    writeTarGz(tgz, [
      ...tarSymlink('sub', victim),
      ...tarEntry('sub/payload', Buffer.from('pwned\n')),
      ...tarEntry('jdk/bin/java', Buffer.from('#!/bin/sh\n')),
    ]);
    const dest = path.join(work, 'out-symlink-slip');
    await extractArchive(tgz, 'tar.gz', dest, MAC).catch(() => undefined);
    expect(fs.readdirSync(victim)).toEqual([]);
  });

  it.skipIf(!HAS_UNZIP)('linux zip 的 .. 成员不会落到目标目录外', async () => {
    const zip = path.join(work, 'slip.zip');
    const payload = Buffer.from('ok');
    writeZip(zip, [
      { name: '../outside.txt', data: Buffer.from('pwned\n') },
      { name: 'jdk/../../outside2.txt', data: Buffer.from('pwned\n') },
      { name: 'jdk/bin/java', data: payload },
    ]);
    const dest = path.join(work, 'out-zip-slip');
    await extractArchive(zip, 'zip', dest, LIN);
    expect(fs.existsSync(path.join(work, 'outside.txt'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'outside2.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'outside.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'jdk', 'bin', 'java'))).toEqual(payload);
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

  it.skipIf(process.platform !== 'win32')('rejects a junction pointing outside', () => {
    const dir = path.join(work, 'junction-tree');
    const outside = path.join(work, 'junction-outside');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction');
    expect(() => assertContained(dir, dir)).toThrow(/symlink points outside/);
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
