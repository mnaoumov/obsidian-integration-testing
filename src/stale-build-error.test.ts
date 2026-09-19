import {
  describe,
  expect,
  it
} from 'vitest';

import { StaleBuildError } from './stale-build-error.ts';

const BUILD_MODIFIED_AT_IN_MILLISECONDS = 1_758_000_000_000;
const FIVE_MINUTES_IN_MILLISECONDS = 300_000;

function createError(): StaleBuildError {
  return new StaleBuildError({
    buildModifiedAtInMilliseconds: BUILD_MODIFIED_AT_IN_MILLISECONDS,
    distPath: 'dist/build',
    sourceModifiedAtInMilliseconds: BUILD_MODIFIED_AT_IN_MILLISECONDS + FIVE_MINUTES_IN_MILLISECONDS,
    sourcePath: 'src/main.ts'
  });
}

describe('StaleBuildError', () => {
  it('should carry the name, both times and the newest source', () => {
    const error = createError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StaleBuildError');
    expect(error.buildModifiedAtInMilliseconds).toBe(BUILD_MODIFIED_AT_IN_MILLISECONDS);
    expect(error.distPath).toBe('dist/build');
    expect(error.sourceModifiedAtInMilliseconds).toBe(BUILD_MODIFIED_AT_IN_MILLISECONDS + FIVE_MINUTES_IN_MILLISECONDS);
    expect(error.sourcePath).toBe('src/main.ts');
  });

  it('should name the file that outdates the build, and by how long', () => {
    const { message } = createError();

    expect(message).toContain('dist/build/main.js');
    expect(message).toContain('src/main.ts');
    expect(message).toContain(new Date(BUILD_MODIFIED_AT_IN_MILLISECONDS).toISOString());
    expect(message).toContain('5 minute(s) later');
  });

  it('should name both escape hatches, so the reader is not left guessing at one', () => {
    const { message } = createError();

    expect(message).toContain('npm run build');
    expect(message).toContain('shouldFailOnStaleBuild: false');
    expect(message).toContain('OBSIDIAN_TEST_ALLOW_STALE_BUILD=1');
  });
});

describe('StaleBuildError.description', () => {
  it('should state the facts without a remedy, for the reader who already escaped the failure', () => {
    const { description } = createError();

    expect(description).toContain('dist/build/main.js');
    expect(description).toContain('src/main.ts');
    expect(description).not.toContain('npm run build');
    expect(description).not.toContain('shouldFailOnStaleBuild');
    expect(description).not.toContain('OBSIDIAN_TEST_ALLOW_STALE_BUILD');
  });

  it('should be the opening of the message, so the two readings cannot drift apart', () => {
    const { description, message } = createError();

    expect(message.startsWith(description)).toBe(true);
  });
});
