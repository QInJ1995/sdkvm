import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractArchive } from '../src/fs/extract.js';
import { normalizeExtracted } from '../src/fs/layout.js';
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
