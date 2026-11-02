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
  it('should publish the original populate stack when source-map preparation fails', async () => {
    function brokenPrepareStackTrace(): never {
      throw new TypeError('code.charCodeAt is not a function');
    }
    const prepareStackTrace = vi.spyOn(Error, 'prepareStackTrace');
    const provide = vi.fn<(key: string, value: unknown) => void>();
    const project = strictProxy<TestProject>({
      config: { environmentOptions: { obsidianTransport: { type: 'obsidian-cdp' } } },
      provide
    });
    const setup = createSetup({
      populate: () => {
        prepareStackTrace.mockImplementation(brokenPrepareStackTrace);
        throw new Error('Missing injected plugin fix-require-modules');
      }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await setup.setup(project);
      expect(provide).toHaveBeenCalledExactlyOnceWith(
        'setupError',
        expect.objectContaining({
          errorName: 'Error',
          transportLabel: 'obsidian-cdp'
        })
      );
      expect(provide.mock.calls[0]?.[1]).toHaveProperty('message', expect.stringContaining('global-setup.test.ts:'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Missing injected plugin fix-require-modules'));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('could not format'));
      expect(Error).toHaveProperty('prepareStackTrace', prepareStackTrace);
      await setup.teardown();
    } finally {
      prepareStackTrace.mockRestore();
      warn.mockRestore();
    }
  });

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
