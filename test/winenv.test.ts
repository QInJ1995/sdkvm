import { describe, expect, it } from 'vitest';
import { registryEnvValue } from '../src/shell/winenv.js';

describe('registryEnvValue', () => {
  it('keeps a leading %VAR% and doubles every other percent', () => {
    expect(registryEnvValue('%USERPROFILE%\\.sdkvm\\current-java')).toEqual({
      data: '%USERPROFILE%\\.sdkvm\\current-java',
      expand: true,
    });
    expect(registryEnvValue('%JAVA_HOME%\\bin%extra%')).toEqual({
      data: '%JAVA_HOME%\\bin%%extra%%',
      expand: true,
    });
  });

  it('stores an absolute path with no env ref as a literal REG_SZ value', () => {
    expect(registryEnvValue('C:\\Java\\bin')).toEqual({ data: 'C:\\Java\\bin', expand: false });
  });
});
