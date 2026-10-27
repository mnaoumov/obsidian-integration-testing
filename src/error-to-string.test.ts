import {
  describe,
  expect,
  it
} from 'vitest';

import { errorToString } from './error-to-string.ts';

describe('errorToString', () => {
  it('should preserve missing-plugin bootstrap instructions when source-map stack preparation throws', () => {
    const message = 'Missing injected plugin fix-require-modules. Run the demo-vault bootstrap to install it.';
    const error = new Error(message);
    Object.defineProperty(error, 'stack', {
      get(): never {
        throw new TypeError('code.charCodeAt is not a function');
      }
    });

    const result = errorToString(error);

    expect(result).toContain(`Error: ${message}`);
    expect(result).toContain('errorToString could not format this error: TypeError: code.charCodeAt is not a function');
  });
});
