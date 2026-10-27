import {
  describe,
  expect,
  it
} from 'vitest';

import { RendererFailedToInitializeError } from './renderer-failed-to-initialize-error.ts';

describe('RendererFailedToInitializeError', () => {
  it('should be an Error with a dedicated name and a message naming the vault', () => {
    const VAULT_PATH = '/tmp/some-vault';
    const error = new RendererFailedToInitializeError(VAULT_PATH);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RendererFailedToInitializeError);
    expect(error.name).toBe('RendererFailedToInitializeError');
    expect(error.message).toContain(VAULT_PATH);
    expect(error.message).toContain('did not initialize');
  });
});
