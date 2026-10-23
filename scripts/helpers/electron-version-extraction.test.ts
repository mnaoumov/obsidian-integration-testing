/**
 * @file
 *
 * Tests for `extractMinRecommendedElectronVersion` and
 * `selectElectronVersionCandidates`.
 *
 * The minified fixture is the exact neighborhood of the constant in the
 * `obsidian-1.14.5.asar.gz` GitHub release asset, read on 2026-10-23; the
 * formatted one is the same two declarations as P20's prettier-formatted copy
 * carries them.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import {
  extractMinRecommendedElectronVersion,
  selectElectronVersionCandidates
} from './electron-version-extraction.ts';

const MINIFIED_APP_JS = '.call(this,t)}}},t}(u3),foe=1e3/60,voe=16,goe="1.14.5",moe="28.2.3";function yoe(e){}';

const FORMATTED_APP_JS = '        voe = 16,\n        goe = \'1.14.5\',\n        moe = \'28.2.3\';\n      function yoe(e) {';

describe('extractMinRecommendedElectronVersion', () => {
  it('should read the version from a minified app.js', () => {
    expect(extractMinRecommendedElectronVersion({ appJs: MINIFIED_APP_JS, version: '1.14.5' })).toBe('28.2.3');
  });

  it('should read the version from a formatted app.js', () => {
    expect(extractMinRecommendedElectronVersion({ appJs: FORMATTED_APP_JS, version: '1.14.5' })).toBe('28.2.3');
  });

  it('should ignore a pair whose first string is not the app version', () => {
    const appJs = `a="9.9.9",b="1.2.3";${MINIFIED_APP_JS}`;
    expect(extractMinRecommendedElectronVersion({ appJs, version: '1.14.5' })).toBe('28.2.3');
  });

  it('should not read a different version as a match', () => {
    expect(extractMinRecommendedElectronVersion({ appJs: MINIFIED_APP_JS, version: '1.14.4' })).toBeUndefined();
  });

  it('should treat a dot in the version literally', () => {
    expect(extractMinRecommendedElectronVersion({ appJs: 'goe="1x14x5",moe="28.2.3";', version: '1.14.5' })).toBeUndefined();
  });

  it('should refuse an ambiguous answer', () => {
    const appJs = `${MINIFIED_APP_JS}x="1.14.5",y="30.0.0";`;
    expect(extractMinRecommendedElectronVersion({ appJs, version: '1.14.5' })).toBeUndefined();
  });

  it('should accept the same answer twice', () => {
    const appJs = `${MINIFIED_APP_JS}x="1.14.5",y="28.2.3";`;
    expect(extractMinRecommendedElectronVersion({ appJs, version: '1.14.5' })).toBe('28.2.3');
  });
});

describe('selectElectronVersionCandidates', () => {
  it('should select only the versions past the newest one carrying the field', () => {
    expect(selectElectronVersionCandidates({
      '0.14.0': {},
      '1.13.10': {},
      '1.13.2': {},
      '1.13.9': { minRecommendedElectronVersion: '28.2.3' }
    })).toEqual(['1.13.10']);
  });

  it('should select nothing once the newest version carries the field', () => {
    expect(selectElectronVersionCandidates({
      '1.13.1': {},
      '1.13.2': { minRecommendedElectronVersion: '28.2.3' }
    })).toEqual([]);
  });

  it('should select every version when none carries the field', () => {
    expect(selectElectronVersionCandidates({ '0.9.0': {}, '1.0.0': {} })).toEqual(['0.9.0', '1.0.0']);
  });
});
