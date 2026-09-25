import {
  describe,
  expect,
  it
} from 'vitest';

import { DETERMINISTIC_RASTER_LAUNCH_FLAGS } from './deterministic-raster.ts';

describe('DETERMINISTIC_RASTER_LAUNCH_FLAGS', () => {
  it('should move rasterization off the GPU', () => {
    expect(DETERMINISTIC_RASTER_LAUNCH_FLAGS).toContain('--disable-gpu-rasterization');
  });

  it('should leave compositing on the GPU', () => {
    expect(DETERMINISTIC_RASTER_LAUNCH_FLAGS).not.toContain('--disable-gpu');
  });
});
