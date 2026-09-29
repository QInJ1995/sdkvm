import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMavenVersion } from '../src/core/version.js';
import { mavenSdk } from '../src/sdk/maven.js';
import { applyMirror } from '../src/vendor/mirror.js';
import { mavenVendor } from '../src/vendor/maven.js';
import type { ResolvedArtifact } from '../src/vendor/types.js';

const MAC = { os: 'mac' as const, arch: 'aarch64' as const };
const WIN = { os: 'windows' as const, arch: 'x64' as const };

const META = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <versioning>
    <latest>4.0.0-rc-7</latest>
    <release>4.0.0-rc-7</release>
    <versions>
      <version>2.2.1</version>
      <version>3.0</version>
      <version>3.8.8</version>
      <version>3.9.8</version>
      <version>3.9.9</version>
      <version>4.0.0-rc-4</version>
      <version>4.0.0-rc-7</version>
    </versions>
  </versioning>
</metadata>`;

function stubMavenApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/maven-metadata.xml')) return new Response(META);
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('maven vendor', () => {
  it('latest ignores prerelease and Maven 2', async () => {
    stubMavenApi();
    const a = await mavenVendor.resolve({ kind: 'latest' }, MAC);
    expect(a.dirName).toBe('maven-3.9.9');
    expect(a.displayName).toBe('Apache Maven 3.9.9');
    expect(a.archive).toBe('tar.gz');
    expect(a.downloadUrl).toBe(
      'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.tar.gz',
    );
    expect(a.checksum).toEqual({
      kind: 'sha512',
      url: `${a.downloadUrl}.sha512`,
    });
  });

  it('major and minor lines pick the newest stable patch', async () => {
    stubMavenApi();
    const major = await mavenVendor.resolve({ kind: 'major', major: 3 }, MAC);
    expect(major.dirName).toBe('maven-3.9.9');
    const line = await mavenVendor.resolve({ kind: 'line', major: 3, minor: 8 }, MAC);
    expect(line.dirName).toBe('maven-3.8.8');
  });

  it('exact stable and prerelease resolve; unstable major does not', async () => {
    stubMavenApi();
    const exact = await mavenVendor.resolve({ kind: 'full', version: '3.9.8' }, MAC);
    expect(exact.dirName).toBe('maven-3.9.8');
    const pre = await mavenVendor.resolve({ kind: 'full', version: '4.0.0-rc-4' }, MAC);
    expect(pre.dirName).toBe('maven-4.0.0-rc-4');
    await expect(mavenVendor.resolve({ kind: 'major', major: 4 }, MAC)).rejects.toThrow(/4/);
    await expect(mavenVendor.resolve({ kind: 'full', version: '2.2.1' }, MAC)).rejects.toThrow(/2\.2\.1/);
  });

  it('windows uses the zip archive', async () => {
    stubMavenApi();
    const a = await mavenVendor.resolve({ kind: 'latest' }, WIN);
    expect(a.archive).toBe('zip');
    expect(a.downloadUrl).toBe(
      'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip',
    );
  });

  it('remote lines are stable minor lines only', async () => {
    stubMavenApi();
    expect(await mavenVendor.listMajors()).toEqual([
      { key: '3.9', lts: false, latestFullVersion: '3.9.9' },
      { key: '3.8', lts: false, latestFullVersion: '3.8.8' },
    ]);
  });

  it('rejects lts', async () => {
    stubMavenApi();
    await expect(mavenVendor.resolve({ kind: 'lts' }, MAC)).rejects.toThrow(/lts/);
  });
});

describe('maven sdk layout', () => {
  it('points MAVEN_HOME at bin/mvn', () => {
    expect(mavenSdk.installDirName).toBe('mavens');
    expect(mavenSdk.currentLinkName).toBe('current-maven');
    expect(mavenSdk.envVar).toBe('MAVEN_HOME');
    expect(mavenSdk.requiresJdk).toBe(true);
    expect(mavenSdk.binRelPath(MAC)).toBe('bin/mvn');
    expect(mavenSdk.binRelPath(WIN)).toBe('bin/mvn.cmd');
    expect(mavenSdk.envBinSuffix(MAC)).toBe('/bin');
    expect(mavenSdk.envBinSuffix(WIN)).toBe('\\bin');
    expect(mavenSdk.versionCheck).toEqual({ args: ['-version'], stream: 'stdout' });
  });
});

describe('applyMirror maven', () => {
  const url =
    'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.tar.gz';

  function artifact(): ResolvedArtifact {
    return {
      vendorId: 'maven',
      version: parseMavenVersion('maven', '3.9.9'),
      dirName: 'maven-3.9.9',
      displayName: 'Apache Maven 3.9.9',
      downloadUrl: url,
      checksum: { kind: 'sha512', url: `${url}.sha512` },
      archive: 'tar.gz',
    };
  }

  it('rewrites the Maven Central prefix and leaves the checksum URL alone', () => {
    const out = applyMirror(artifact(), MAC, 'https://maven.aliyun.com/repository/central');
    expect(out.downloadUrl).toBe(
      'https://maven.aliyun.com/repository/central/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.tar.gz',
    );
    expect(out.checksum).toEqual({ kind: 'sha512', url: `${url}.sha512` });
  });

  it('no mirror → untouched', () => {
    expect(applyMirror(artifact(), MAC, null).downloadUrl).toBe(url);
  });
});

describe('metadata 健壮性', () => {
  it('页面不是 metadata XML 时明确报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway error</html>')));
    await expect(mavenVendor.listMajors()).rejects.toThrow(/format unrecognized/);
  });

  it('metadata 里没有可用版本时明确报错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<metadata><versioning><versions /></versioning></metadata>')),
    );
    await expect(mavenVendor.listMajors()).rejects.toThrow(/listed no versions/);
  });
});
