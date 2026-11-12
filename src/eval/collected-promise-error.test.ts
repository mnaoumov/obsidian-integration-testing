import {
  describe,
  expect,
  it
} from 'vitest';

import { CollectedPromiseError } from './collected-promise-error.ts';

describe('CollectedPromiseError', () => {
  it('should name the transport and the cause, and say what to do', () => {
    const cause = new Error('Promise was collected');
    const error = new CollectedPromiseError({ cause, transportName: 'desktop (CDP)' });

    expect(error.name).toBe('CollectedPromiseError');
    expect(error.transportName).toBe('desktop (CDP)');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('desktop (CDP)');
    expect(error.message).toContain('garbage-collected');
    expect(error.message).toContain('Keep a reference to the resolver');
  });
});
