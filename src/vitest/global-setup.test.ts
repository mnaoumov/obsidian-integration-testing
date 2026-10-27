import type { TestProject } from 'vitest/node';

import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { strictProxy } from '../strict-proxy.ts';
import { createSetup } from './global-setup.ts';

describe('createSetup', () => {
  it('should publish and log the original populate failure when its stack cannot be prepared', async () => {
    const message = 'Missing injected plugin fix-require-modules. Run the demo-vault bootstrap to install it.';
    const error = new Error(message);
    Object.defineProperty(error, 'stack', {
      get(): never {
        throw new TypeError('code.charCodeAt is not a function');
      }
    });
    const provide = vi.fn();
    const project = strictProxy<TestProject>({
      config: { environmentOptions: { obsidianTransport: { type: 'obsidian-cdp' } } },
      provide
    });
    const setup = createSetup({
      populate: () => {
        throw error;
      }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(setup.setup(project)).resolves.toBeUndefined();
      expect(provide).toHaveBeenCalledExactlyOnceWith('setupError', {
        errorName: 'Error',
        message: `Error: ${message}\n<unprintable>\n(errorToString could not format this error: TypeError: code.charCodeAt is not a function)`,
        transportLabel: 'obsidian-cdp'
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(message));
      await setup.teardown();
    } finally {
      warn.mockRestore();
    }
  });
});
