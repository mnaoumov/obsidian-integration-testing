import {
  describe,
  expect,
  it
} from 'vitest';

import { DEFAULT_EVAL_CAP_IN_MILLISECONDS } from './eval-cap.ts';

describe('DEFAULT_EVAL_CAP_IN_MILLISECONDS', () => {
  /*
   * Pinned because the number is PUBLISHED. Consumers size their closures against it — a wait budget
   * bounded by this value, an eslint rule's default cap — so lowering it silently invalidates every
   * closure sized under the old one, in the direction that produces the unreadable failure. Changing it
   * is a breaking change, and this assertion is where that has to be admitted rather than discovered.
   */
  it('should be 30000ms', () => {
    expect(DEFAULT_EVAL_CAP_IN_MILLISECONDS).toBe(30_000);
  });
});
