import { describe, expect, it } from 'vitest';
import { applyMirror, applyMirrorDetail } from '../src/vendor/mirror.js';
import { parseVersion } from '../src/core/version.js';
import { parseGoVersion, parseFlutterVersion, parseNodeVersion, parseMinicondaVersion, parsePythonVersion } from '../src/core/version.js';
import type { ResolvedArtifact } from '../src/vendor/types.js';

function artifact(url: string, vendorId: string = 'temurin'): ResolvedArtifact {
  return {
    vendorId,
    version: parseVersion(vendorId, '21.0.12.1+1'),
    dirName: `${vendorId}-21`,
    displayName: 'Test',
    downloadUrl: url,
    checksum: null,
    archive: 'tar.gz',
  };
}

const GH =
  'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz';

describe('applyMirror', () => {
  const mac = { os: 'mac' as const, arch: 'aarch64' as const };

  it('rewrites temurin github URL to mirror structure', () => {
    const out = applyMirror(artifact(GH), mac, 'https://mirrors.nju.edu.cn/adoptium');
    expect(out.downloadUrl).toBe(
      'https://mirrors.nju.edu.cn/adoptium/21/jdk/aarch64/mac/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz',
    );
  });

  it('normalizes trailing slashes', () => {
    const out = applyMirror(artifact(GH), mac, 'https://mirrors.nju.edu.cn/adoptium/');
    expect(out.downloadUrl).toContain('https://mirrors.nju.edu.cn/adoptium/21/');
  });

  it('no mirror → untouched', () => {
    expect(applyMirror(artifact(GH), mac, null).downloadUrl).toBe(GH);
  });

  it('reports applied=false for unsupported vendors and unmatched URLs', () => {
    const zulu = artifact('https://cdn.azul.com/zulu/bin/zulu.tar.gz', 'zulu');
    expect(applyMirrorDetail(zulu, mac, 'https://mirrors.nju.edu.cn/adoptium').applied).toBe(false);

    const nonGh = artifact('https://example.com/jdk.tar.gz');
    expect(applyMirrorDetail(nonGh, mac, 'https://mirrors.nju.edu.cn/adoptium').applied).toBe(false);

    expect(applyMirrorDetail(artifact(GH), mac, 'https://mirrors.nju.edu.cn/adoptium').applied).toBe(
      true,
    );
  });

  it('trims whitespace in mirror root', () => {
    const out = applyMirror(artifact(GH), mac, '  https://mirrors.nju.edu.cn/adoptium  ');
    expect(out.downloadUrl).toContain('https://mirrors.nju.edu.cn/adoptium/21/');
  });

  it('rewrites golang URL by filename concat (golang.google.cn)', () => {
    const a: ResolvedArtifact = {
      vendorId: 'golang',
      version: parseGoVersion('golang', '1.24.5'),
      dirName: 'golang-1.24.5',
      displayName: 'Go 1.24.5',
      downloadUrl: 'https://go.dev/dl/go1.24.5.darwin-arm64.tar.gz',
      checksum: null,
      archive: 'tar.gz',
    };
    const out = applyMirror(a, mac, 'https://golang.google.cn/dl');
    expect(out.downloadUrl).toBe('https://golang.google.cn/dl/go1.24.5.darwin-arm64.tar.gz');
  });

  it('golang mirror root without /dl path works (aliyun)', () => {
    const a: ResolvedArtifact = {
      vendorId: 'golang',
      version: parseGoVersion('golang', '1.24.5'),
      dirName: 'golang-1.24.5',
      displayName: 'Go 1.24.5',
      downloadUrl: 'https://go.dev/dl/go1.24.5.linux-amd64.tar.gz',
      checksum: null,
      archive: 'tar.gz',
    };
    const out = applyMirror(a, mac, 'https://mirrors.aliyun.com/golang/');
    expect(out.downloadUrl).toBe('https://mirrors.aliyun.com/golang/go1.24.5.linux-amd64.tar.gz');
  });

  it('non-temurin untouched', () => {
    const a = artifact('https://cdn.azul.com/zulu/bin/zulu21.tar.gz', 'zulu');
    expect(applyMirror(a, mac, 'https://mirrors.nju.edu.cn/adoptium').downloadUrl).toBe(
      'https://cdn.azul.com/zulu/bin/zulu21.tar.gz',
    );
  });

  it('non-github temurin URL untouched', () => {
    const a = artifact('https://example.com/other.tar.gz');
    expect(applyMirror(a, mac, 'https://m.example').downloadUrl).toBe('https://example.com/other.tar.gz');
  });
});


describe('applyMirror: flutter', () => {
  const lin = { os: 'linux' as const, arch: 'x64' as const };

  function flutterArtifact(): ResolvedArtifact {
    return {
      vendorId: 'flutter',
      version: parseFlutterVersion('flutter', '3.47.5'),
      dirName: 'flutter-3.47.5',
      displayName: 'Flutter 3.47.5',
      downloadUrl:
        'https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.47.5-stable.tar.xz',
      checksum: { kind: 'sha256', expected: 'a'.repeat(64) },
      archive: 'tar.xz',
    };
  }

  it('replaces the official bucket prefix with the mirror root', () => {
    const out = applyMirror(flutterArtifact(), lin, 'https://mirror.nju.edu.cn/flutter/flutter_infra_release');
    expect(out.downloadUrl).toBe(
      'https://mirror.nju.edu.cn/flutter/flutter_infra_release/releases/stable/linux/flutter_linux_3.47.5-stable.tar.xz',
    );
    expect(out.archive).toBe('tar.xz');
  });

  it('no mirror → untouched', () => {
    const a = flutterArtifact();
    expect(applyMirror(a, lin, null).downloadUrl).toBe(a.downloadUrl);
  });
});

describe('applyMirror nodejs', () => {
  const lin = { os: 'linux' as const, arch: 'x64' as const };
  const NODE_URL = 'https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz';

  function nodeArtifact(): ResolvedArtifact {
    return {
      vendorId: 'nodejs',
      version: parseNodeVersion('nodejs', '22.20.0'),
      dirName: 'nodejs-22.20.0',
      displayName: 'Node.js 22.20.0',
      downloadUrl: NODE_URL,
      checksum: { kind: 'sha256', expected: 'a'.repeat(64) },
      archive: 'tar.xz',
    };
  }

  it('rewrites nodejs.org/dist prefix to mirror root', () => {
    const out = applyMirror(nodeArtifact(), lin, 'https://mirror.nju.edu.cn/nodejs-release');
    expect(out.downloadUrl).toBe(
      'https://mirror.nju.edu.cn/nodejs-release/v22.20.0/node-v22.20.0-linux-x64.tar.xz',
    );
  });

  it('no mirror → untouched', () => {
    expect(applyMirror(nodeArtifact(), lin, null).downloadUrl).toBe(NODE_URL);
  });
});

describe('applyMirror miniconda', () => {
  const mac = { os: 'mac' as const, arch: 'aarch64' as const };
  const official =
    'https://repo.anaconda.com/miniconda/Miniconda3-py313_26.7.1-1-MacOSX-arm64.sh';

  function minicondaArtifact(): ResolvedArtifact {
    return {
      vendorId: 'miniconda',
      version: parseMinicondaVersion('miniconda', 'py313_26.7.1-1'),
      dirName: 'miniconda-py313_26.7.1-1',
      displayName: 'Miniconda py313_26.7.1-1',
      downloadUrl: official,
      checksum: { kind: 'sha256', expected: 'ab'.repeat(32) },
      archive: 'sh',
    };
  }

  it('rewrites only the miniconda prefix and keeps the expected hash', () => {
    const detail = applyMirrorDetail(
      minicondaArtifact(),
      mac,
      'https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/',
    );
    expect(detail.applied).toBe(true);
    expect(detail.artifact.downloadUrl).toBe(
      'https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-py313_26.7.1-1-MacOSX-arm64.sh',
    );
    expect(detail.artifact.checksum).toEqual({ kind: 'sha256', expected: 'ab'.repeat(32) });
  });
});

describe('applyMirror cpython', () => {
  const mac = { os: 'mac' as const, arch: 'aarch64' as const };
  const official =
    'https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.12.7+20260924-aarch64-apple-darwin-install_only_stripped.tar.gz';

  function pythonArtifact(): ResolvedArtifact {
    return {
      vendorId: 'cpython',
      version: parsePythonVersion('cpython', '3.12.7'),
      dirName: 'cpython-3.12.7',
      displayName: 'Python 3.12.7',
      downloadUrl: official,
      checksum: { kind: 'sha256', expected: 'cd'.repeat(32) },
      archive: 'tar.gz',
    };
  }

  it('rewrites only the GitHub download prefix and keeps the tag, filename, and hash', () => {
    const detail = applyMirrorDetail(pythonArtifact(), mac, 'https://example.invalid/python-standalone/');
    expect(detail.applied).toBe(true);
    expect(detail.artifact.downloadUrl).toBe(
      'https://example.invalid/python-standalone/20260924/cpython-3.12.7+20260924-aarch64-apple-darwin-install_only_stripped.tar.gz',
    );
    expect(detail.artifact.checksum).toEqual({ kind: 'sha256', expected: 'cd'.repeat(32) });
  });
});
