import {
  describe,
  expect,
  it
} from 'vitest';

import { deriveEcmaScriptVersion } from './ecmascript-version.ts';

describe('deriveEcmaScriptVersion', () => {
  it('maps each Chromium-major breakpoint to its ECMAScript edition', () => {
    expect(deriveEcmaScriptVersion('51.0.2704.103')).toBe('ES2015');
    expect(deriveEcmaScriptVersion('52.0.2743.116')).toBe('ES2016');
    expect(deriveEcmaScriptVersion('58.0.3029.110')).toBe('ES2017');
    expect(deriveEcmaScriptVersion('64.0.3282.140')).toBe('ES2018');
    expect(deriveEcmaScriptVersion('73.0.3683.121')).toBe('ES2019');
    expect(deriveEcmaScriptVersion('80.0.3987.165')).toBe('ES2020');
    expect(deriveEcmaScriptVersion('85.0.4183.121')).toBe('ES2021');
    expect(deriveEcmaScriptVersion('94.0.4606.81')).toBe('ES2022');
    expect(deriveEcmaScriptVersion('110.0.5481.208')).toBe('ES2023');
    expect(deriveEcmaScriptVersion('122.0.6261.156')).toBe('ES2024');
  });

  it('returns the highest edition whose threshold is met (between breakpoints)', () => {
    expect(deriveEcmaScriptVersion('100.0.4896.127')).toBe('ES2022');
    expect(deriveEcmaScriptVersion('114.0.5735.289')).toBe('ES2023');
    expect(deriveEcmaScriptVersion('130.0.6723.152')).toBe('ES2024');
  });

  it('reads only the leading major segment', () => {
    expect(deriveEcmaScriptVersion('94')).toBe('ES2022');
  });

  it('returns `undefined` for a Chromium major below the earliest tracked edition', () => {
    expect(deriveEcmaScriptVersion('50.0.2661.102')).toBeUndefined();
  });

  it('returns `undefined` for a malformed version', () => {
    expect(deriveEcmaScriptVersion('not-a-version')).toBeUndefined();
    expect(deriveEcmaScriptVersion('')).toBeUndefined();
  });
});
