import {
  describe,
  expect,
  it
} from 'vitest';

import { getVersionMetadata } from './obsidian-metadata.ts';

describe('getVersionMetadata', () => {
  it('returns the run floor for a known catalyst version', () => {
    expect(getVersionMetadata('1.13.1')?.minRunnableInstallerVersion).toBe('1.1.9');
  });

  it('records 1.13.0 as needing installer 1.6.5 (silent-fallback correction, not the false-positive 1.1.9)', () => {
    // 1.13.0 silently falls back to the installer's bundled asar below 1.6.5; verified over CDP that it
    // Does not actually run 1.13.0 on installer 1.1.9. See CLAUDE.md L20's silent-fallback caveat.
    expect(getVersionMetadata('1.13.0')?.minRunnableInstallerVersion).toBe('1.6.5');
  });

  it('returns the recommended installer floor for an old version that carries one', () => {
    const metadata = getVersionMetadata('0.15.6');
    expect(metadata?.minRunnableInstallerVersion).toBe('0.6.4');
    expect(metadata?.minRecommendedInstallerVersion).toBe('0.11.0');
  });

  it('exposes the recommended Electron version and channel for a modern version', () => {
    const metadata = getVersionMetadata('1.5.3');
    expect(metadata?.minRecommendedElectronVersion).toBe('25.8.1');
    expect(metadata?.channel).toBe('public');
  });

  it('returns `undefined` for a version absent from the table', () => {
    expect(getVersionMetadata('999.999.999')).toBeUndefined();
  });
});
