import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ObsidianCdpTransportOptions } from './transport-options.ts';

import {
  ALLOW_STALE_BUILD_ENVIRONMENT_VARIABLE_NAME,
  checkIsBuildStale,
  checkIsSourceFileName,
  findNewestSourceModification,
  willFailOnStaleBuild
} from './stale-build-detection.ts';

const BASE_IN_SECONDS = 1_758_000_000;
const SECONDS_IN_MILLISECONDS = 1000;

/**
 * The epoch milliseconds a {@link writeAt} offset corresponds to.
 *
 * @param offsetInSeconds - The offset passed to {@link writeAt}.
 * @returns The epoch milliseconds.
 */
function toMilliseconds(offsetInSeconds: number): number {
  return (BASE_IN_SECONDS + offsetInSeconds) * SECONDS_IN_MILLISECONDS;
}

/**
 * Writes a file with an mtime a fixed number of seconds past the fixture base, so every assertion here
 * compares times this test chose rather than times the filesystem happened to record.
 *
 * @param path - The absolute path to write.
 * @param offsetInSeconds - Seconds past {@link BASE_IN_SECONDS} to stamp the file with.
 */
function writeAt(path: string, offsetInSeconds: number): void {
  writeFileSync(path, 'x');
  const timeInSeconds = BASE_IN_SECONDS + offsetInSeconds;
  utimesSync(path, timeInSeconds, timeInSeconds);
}

describe('checkIsBuildStale', () => {
  it('should report stale when the newest source is newer than the build', () => {
    expect(checkIsBuildStale({
      buildModifiedAtInMilliseconds: toMilliseconds(0),
      newestSource: { modifiedAtInMilliseconds: toMilliseconds(1), path: 'src/main.ts' }
    })).toBe(true);
  });

  it('should report fresh when the build is newer', () => {
    expect(checkIsBuildStale({
      buildModifiedAtInMilliseconds: toMilliseconds(1),
      newestSource: { modifiedAtInMilliseconds: toMilliseconds(0), path: 'src/main.ts' }
    })).toBe(false);
  });

  it('should report fresh on an exact tie, so a source the build itself wrote is not stale', () => {
    expect(checkIsBuildStale({
      buildModifiedAtInMilliseconds: toMilliseconds(0),
      newestSource: { modifiedAtInMilliseconds: toMilliseconds(0), path: 'src/main.ts' }
    })).toBe(false);
  });

  it('should report fresh when there is no source, rather than failing every run of such a project', () => {
    expect(checkIsBuildStale({ buildModifiedAtInMilliseconds: toMilliseconds(0), newestSource: undefined })).toBe(false);
  });
});

describe('checkIsSourceFileName', () => {
  it('should accept a source file', () => {
    expect(checkIsSourceFileName('main.ts')).toBe(true);
    expect(checkIsSourceFileName('styles.css')).toBe(true);
    expect(checkIsSourceFileName('testing.ts')).toBe(true);
  });

  it('should reject a test file, which no bundler entry graph reaches', () => {
    expect(checkIsSourceFileName('main.test.ts')).toBe(false);
    expect(checkIsSourceFileName('vault.integration.test.ts')).toBe(false);
  });
});

describe('findNewestSourceModification', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'stale-build-detection-'));
    mkdirSync(join(projectRoot, 'src'));
  });

  afterEach(() => {
    rmSync(projectRoot, { force: true, recursive: true });
  });

  it('should return the newest source as a project-relative POSIX path', async () => {
    writeAt(join(projectRoot, 'src', 'main.ts'), 10);
    mkdirSync(join(projectRoot, 'src', 'nested'));
    writeAt(join(projectRoot, 'src', 'nested', 'component.ts'), 30);
    writeAt(join(projectRoot, 'manifest.json'), 20);

    await expect(findNewestSourceModification(projectRoot)).resolves.toEqual({
      modifiedAtInMilliseconds: toMilliseconds(30),
      path: 'src/nested/component.ts'
    });
  });

  it('should include the root files the build also reads', async () => {
    writeAt(join(projectRoot, 'src', 'main.ts'), 10);
    writeAt(join(projectRoot, 'manifest.json'), 20);
    writeAt(join(projectRoot, 'styles.css'), 40);

    await expect(findNewestSourceModification(projectRoot)).resolves.toEqual({
      modifiedAtInMilliseconds: toMilliseconds(40),
      path: 'styles.css'
    });
  });

  it('should ignore a test file even when it is the newest thing in the tree', async () => {
    writeAt(join(projectRoot, 'src', 'main.ts'), 10);
    writeAt(join(projectRoot, 'src', 'main.test.ts'), 900);

    await expect(findNewestSourceModification(projectRoot)).resolves.toEqual({
      modifiedAtInMilliseconds: toMilliseconds(10),
      path: 'src/main.ts'
    });
  });

  it('should not descend into node_modules or .git', async () => {
    writeAt(join(projectRoot, 'src', 'main.ts'), 10);
    for (const name of ['node_modules', '.git']) {
      mkdirSync(join(projectRoot, 'src', name));
      writeAt(join(projectRoot, 'src', name, 'vendored.ts'), 900);
    }

    await expect(findNewestSourceModification(projectRoot)).resolves.toEqual({
      modifiedAtInMilliseconds: toMilliseconds(10),
      path: 'src/main.ts'
    });
  });

  it('should return undefined for a project whose sources are not under src/', async () => {
    rmSync(join(projectRoot, 'src'), { recursive: true });

    await expect(findNewestSourceModification(projectRoot)).resolves.toBeUndefined();
  });
});

describe('willFailOnStaleBuild', () => {
  beforeEach(() => {
    vi.stubEnv(ALLOW_STALE_BUILD_ENVIRONMENT_VARIABLE_NAME, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should default to failing', () => {
    expect(willFailOnStaleBuild(undefined)).toBe(true);
    expect(willFailOnStaleBuild({ type: 'obsidian-cdp' })).toBe(true);
  });

  it('should honour the option', () => {
    const options: ObsidianCdpTransportOptions = { shouldFailOnStaleBuild: false, type: 'obsidian-cdp' };

    expect(willFailOnStaleBuild(options)).toBe(false);
    expect(willFailOnStaleBuild({ shouldFailOnStaleBuild: true, type: 'obsidian-cdp' })).toBe(true);
  });

  it('should let the environment variable override a project that asked to fail', () => {
    vi.stubEnv(ALLOW_STALE_BUILD_ENVIRONMENT_VARIABLE_NAME, '1');

    expect(willFailOnStaleBuild({ shouldFailOnStaleBuild: true, type: 'obsidian-cdp' })).toBe(false);
  });

  it('should treat an empty, zero or false value as unset, so a leftover .env line cannot disarm the guard', () => {
    for (const value of ['', ' '.repeat(3), '0', 'false', 'FALSE']) {
      vi.stubEnv(ALLOW_STALE_BUILD_ENVIRONMENT_VARIABLE_NAME, value);

      expect(willFailOnStaleBuild(undefined)).toBe(true);
    }
  });
});
