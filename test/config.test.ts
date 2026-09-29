import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, updateConfig } from '../src/core/config.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-config-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
});

describe('config', () => {
  it('defaults when missing', () => {
    const c = loadConfig();
    expect(c.defaultVendor).toBe('temurin');
    expect(c.mirror.temurin).toBeUndefined();
    expect(c.mavenRegistries).toEqual({});
    expect(c.mavenSettings).toBe('');
  });

  it('roundtrip', () => {
    const c = loadConfig();
    c.mirror.temurin = 'https://mirrors.nju.edu.cn/adoptium';
    c.npmRegistries.myprivate = 'http://xxx/registry/';
    c.mavenRegistries.myrepo = 'https://example.com/maven/';
    c.mavenSettings = '/tmp/settings.xml';
    saveConfig(c);
    const loaded = loadConfig();
    expect(loaded.mirror.temurin).toBe('https://mirrors.nju.edu.cn/adoptium');
    expect(loaded.npmRegistries.myprivate).toBe('http://xxx/registry/');
    expect(loaded.mavenRegistries.myrepo).toBe('https://example.com/maven/');
    expect(loaded.mavenSettings).toBe('/tmp/settings.xml');
  });

  it('updateConfig mutates under lock', () => {
    updateConfig((c) => {
      c.mirror.golang = 'https://mirrors.aliyun.com/golang';
    });
    expect(loadConfig().mirror.golang).toBe('https://mirrors.aliyun.com/golang');
  });

  it('corrupt file → backup + defaults', () => {
    fs.writeFileSync(path.join(home, 'config.json'), '{not json');
    const c = loadConfig();
    expect(c.defaultVendor).toBe('temurin');
    expect(fs.existsSync(path.join(home, 'config.json.bak'))).toBe(true);
  });

  it('valid-JSON non-object (null / number / array) counts as corruption, not a crash', () => {
    // JSON.parse(null) 成功但 defaultVendor 属性访问会 TypeError：必须走损坏兜底
    fs.writeFileSync(path.join(home, 'config.json'), 'null');
    expect(loadConfig().defaultVendor).toBe('temurin');
    expect(fs.existsSync(path.join(home, 'config.json.bak'))).toBe(true);

    fs.writeFileSync(path.join(home, 'config.json'), '42');
    expect(loadConfig().mirror).toEqual({});

    fs.writeFileSync(path.join(home, 'config.json'), '[1,2]');
    expect(loadConfig().npmRegistries).toEqual({});
  });

  it('invalid vendor falls back to temurin', () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ version: 1, defaultVendor: 'unknown' }),
    );
    expect(loadConfig().defaultVendor).toBe('temurin');
  });
});
