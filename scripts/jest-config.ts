import type { Config } from 'jest';

import { join } from 'node:path';

export const jestConfig: Config = {
  extensionsToTreatAsEsm: ['.ts'],
  rootDir: join(import.meta.dirname, '..'),
  testMatch: ['**/jest/*.jest.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }]
  }
};
