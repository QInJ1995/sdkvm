import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findInstalled, listInstalled } from '../src/core/registry.js';
import { SdkvmError } from '../src/util/errors.js';

let home: string;

function mkJdk(dirName: string): void {
  fs.mkdirSync(path.join(home, 'jdks', dirName), { recursive: true });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-registry-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
});

describe('registry', () => {
  it('lists and sorts installed', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('zulu-21.0.12.1');
    mkJdk('temurin-17.0.13+11');
    const list = listInstalled('java');
    expect(list.map((j) => j.version.major)).toEqual([17, 21, 21]);
    expect(list[0]?.version.vendor).toBe('temurin');
  });

  it('ignores non-jdk dirs', () => {
    mkJdk('temurin-21.0.5+11');
    fs.mkdirSync(path.join(home, 'jdks', 'random'));
    expect(listInstalled('java')).toHaveLength(1);
  });

  it('major match picks highest across vendors', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('zulu-21.0.12.1');
    expect(findInstalled('java', '21').dirPath.endsWith('zulu-21.0.12.1')).toBe(true);
  });

  it('vendor prefix match', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('zulu-21.0.12.1');
    expect(findInstalled('java', 'temurin-21').dirPath.endsWith('temurin-21.0.5+11')).toBe(true);
  });

  it('full prefix match ignores build', () => {
    mkJdk('temurin-21.0.5+11');
    expect(findInstalled('java', '21.0.5').dirPath.endsWith('temurin-21.0.5+11')).toBe(true);
  });

  it('lts match', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('temurin-22.0.1+2');
    expect(findInstalled('java', 'lts').version.major).toBe(21);
  });

  it('node lts matches even majors, not Java LTS set', () => {
    fs.mkdirSync(path.join(home, 'nodes', 'nodejs-22.20.0'), { recursive: true });
    fs.mkdirSync(path.join(home, 'nodes', 'nodejs-21.0.0'), { recursive: true });
    fs.mkdirSync(path.join(home, 'nodes', 'nodejs-24.2.0'), { recursive: true });
    expect(findInstalled('node', 'lts').dirPath.endsWith('nodejs-24.2.0')).toBe(true);
  });

  it('go lts is rejected', () => {
    expect(() => findInstalled('go', 'lts')).toThrow(SdkvmError);
  });

  it('miniconda full spec matches python pin and build pin', () => {
    const root = path.join(home, 'minicondas');
    fs.mkdirSync(path.join(root, 'miniconda-py313_26.7.1-1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'miniconda-py313_26.7.1-2'), { recursive: true });
    fs.mkdirSync(path.join(root, 'miniconda-py314_26.7.1-1'), { recursive: true });
    expect(findInstalled('miniconda', 'py313').dirPath.endsWith('miniconda-py313_26.7.1-2')).toBe(true);
    expect(findInstalled('miniconda', '26.7.1-1').dirPath.endsWith('miniconda-py314_26.7.1-1')).toBe(true);
    expect(findInstalled('miniconda', 'py313_26.7.1-1').dirPath.endsWith('miniconda-py313_26.7.1-1')).toBe(true);
    expect(findInstalled('miniconda', '26.7').dirPath.endsWith('miniconda-py314_26.7.1-1')).toBe(true);
    expect(findInstalled('miniconda', '26').dirPath.endsWith('miniconda-py314_26.7.1-1')).toBe(true);
  });

  it('python loose specs skip an installed prerelease', () => {
    const root = path.join(home, 'pythons');
    fs.mkdirSync(path.join(root, 'cpython-3.12.7'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cpython-3.14.0rc2'), { recursive: true });
    expect(findInstalled('python', 'latest').dirPath.endsWith('cpython-3.12.7')).toBe(true);
    expect(findInstalled('python', '3').dirPath.endsWith('cpython-3.12.7')).toBe(true);
    expect(findInstalled('python', '3.12').dirPath.endsWith('cpython-3.12.7')).toBe(true);
    expect(findInstalled('python', '3.14.0rc2').dirPath.endsWith('cpython-3.14.0rc2')).toBe(true);
    expect(() => findInstalled('python', '3.14')).toThrow(SdkvmError);
  });

  it('python line and latest prefer the final release over a prerelease of the same numbers', () => {
    const root = path.join(home, 'pythons');
    fs.mkdirSync(path.join(root, 'cpython-3.12.7'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cpython-3.14.0rc2'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cpython-3.14.0'), { recursive: true });
    expect(findInstalled('python', 'latest').dirPath.endsWith('cpython-3.14.0')).toBe(true);
    expect(findInstalled('python', '3.14').dirPath.endsWith('cpython-3.14.0')).toBe(true);
    expect(findInstalled('python', '3.14.0').dirPath.endsWith('cpython-3.14.0')).toBe(true);
    expect(findInstalled('python', '3.14.0rc2').dirPath.endsWith('cpython-3.14.0rc2')).toBe(true);
  });

  it('no match throws with installed list', () => {
    mkJdk('temurin-21.0.5+11');
    try {
      findInstalled('java', '99');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SdkvmError);
      expect((e as SdkvmError).hint).toContain('temurin-21.0.5+11');
    }
  });
});
