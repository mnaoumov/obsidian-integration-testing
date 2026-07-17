import {
  describe,
  expect,
  it
} from 'vitest';

import { normalizeOptionalProperties } from './normalize-optional-properties.ts';

interface Sample {
  readonly always: string;
  readonly maybe?: number;
}

describe('normalizeOptionalProperties', () => {
  it('returns the object typed as the target type', () => {
    const result = normalizeOptionalProperties<Sample>({ always: 'a', maybe: 1 });
    expect(result).toEqual({ always: 'a', maybe: 1 });
  });

  it('permits an explicit `undefined` for an optional property (kept at runtime)', () => {
    const result = normalizeOptionalProperties<Sample>({ always: 'a', maybe: undefined });
    expect(result.always).toBe('a');
    expect(result.maybe).toBeUndefined();
    expect('maybe' in result).toBe(true);
  });
});
