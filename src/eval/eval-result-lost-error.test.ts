import {
  describe,
  expect,
  it
} from 'vitest';

import { EvalResultLostError } from './eval-result-lost-error.ts';

describe('EvalResultLostError', () => {
  it('should name the loss, the elapsed time and the diagnosis', () => {
    const error = new EvalResultLostError({ diagnosis: 'The page was REPLACED.', elapsedInMilliseconds: 1234 });

    expect(error.name).toBe('EvalResultLostError');
    expect(error.diagnosis).toBe('The page was REPLACED.');
    expect(error.message).toContain('after 1234ms');
    expect(error.message).toContain('went away');
    expect(error.message).toContain('The page was REPLACED.');
  });

  it('should say when the transport cannot inspect the page', () => {
    const error = new EvalResultLostError({ diagnosis: null, elapsedInMilliseconds: 5 });

    expect(error.diagnosis).toBeNull();
    expect(error.message).toContain('cannot inspect the page');
  });
});
