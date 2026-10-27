import {
  describe,
  expect,
  it
} from 'vitest';

import { IncompatibleInstallerVersionError } from './incompatible-installer-version-error.ts';

describe('IncompatibleInstallerVersionError', () => {
  const error = new IncompatibleInstallerVersionError({
    appVersion: '1.13.1',
    installerVersion: '0.14.5',
    minRunnableInstallerVersion: '1.1.9'
  });

  it('is an Error with the specific name', () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('IncompatibleInstallerVersionError');
  });

  it('names all three versions in the message', () => {
    expect(error.message).toContain('0.14.5');
    expect(error.message).toContain('1.13.1');
    expect(error.message).toContain('1.1.9');
  });

  it('exposes the versions as fields', () => {
    expect(error.appVersion).toBe('1.13.1');
    expect(error.installerVersion).toBe('0.14.5');
    expect(error.minRunnableInstallerVersion).toBe('1.1.9');
  });
});
