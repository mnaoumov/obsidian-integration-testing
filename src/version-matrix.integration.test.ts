/**
 * @file
 *
 * Exercises {@link runObsidianVersionMatrix} against the **live** desktop
 * releases manifest.
 *
 * The runner never launches Obsidian — the caller's `run` callback does — so a
 * stub callback covers the whole decision path (fetch, resolve, de-duplicate,
 * sequence) in seconds and leaks no instance.
 *
 * The two channels converge and diverge over time, so nothing here asserts a
 * concrete version or a fixed run count. What must hold either way is that the
 * matrix never runs the same build twice, and that a specifier naming the same
 * build as an alias collapses onto it.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianVersionMatrixEntry } from './version-matrix.ts';

import {
  CATALYST_LATEST,
  PUBLIC_LATEST
} from './obsidian-version.ts';
import { runObsidianVersionMatrix } from './run-version-matrix.ts';

const EXPLICIT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_SUPPORTED_ENDS = 2;

/**
 * Runs the matrix with a recording stub in place of a real suite run.
 *
 * @param versions - The specifiers to run against, or `undefined` for the default.
 * @returns The entries the runner handed to the callback, in order.
 */
async function collectEntries(versions?: readonly string[] | string): Promise<ObsidianVersionMatrixEntry[]> {
  const entries: ObsidianVersionMatrixEntry[] = [];
  await runObsidianVersionMatrix({
    run: (entry) => {
      entries.push(entry);
    },
    ...versions !== undefined && { versions }
  });
  return entries;
}

describe('runObsidianVersionMatrix', () => {
  it('should run once per distinct version across both supported ends by default', async () => {
    const entries = await collectEntries();

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.length).toBeLessThanOrEqual(MAX_SUPPORTED_ENDS);

    for (const { version } of entries) {
      expect(version).toMatch(EXPLICIT_VERSION_PATTERN);
    }

    // The whole point: a build is never provisioned twice.
    const versions = entries.map(({ version }) => version);
    expect(new Set(versions).size).toBe(versions.length);

    // Both ends are always accounted for, whether they collapsed or not.
    const specs = entries.flatMap(({ specs: entrySpecs }) => entrySpecs);
    expect(specs).toContain(PUBLIC_LATEST);
    expect(specs).toContain(CATALYST_LATEST);
    expect(specs).toHaveLength(MAX_SUPPORTED_ENDS);
  });

  it('should collapse an explicit version onto the alias that resolves to it', async () => {
    const [firstEntry] = await collectEntries([CATALYST_LATEST]);
    expect(firstEntry).toBeDefined();
    const catalystVersion = firstEntry?.version ?? '';

    // De-duplication is keyed on the RESOLVED version, so naming the catalyst
    // Build explicitly must not buy a second run of the same build.
    const entries = await collectEntries([catalystVersion, CATALYST_LATEST]);

    expect(entries).toEqual([{ specs: [catalystVersion, CATALYST_LATEST], version: catalystVersion }]);
  });

  it('should accept a comma-separated list and de-duplicate it', async () => {
    const entries = await collectEntries('1.12.7, 1.13.4, 1.12.7');

    expect(entries.map(({ version }) => version)).toEqual(['1.12.7', '1.13.4']);
  });

  it('should surface which version failed', async () => {
    await expect(runObsidianVersionMatrix({
      run: ({ version }) => {
        throw new Error(`suite failed on ${version}`);
      },
      versions: ['1.12.7']
    })).rejects.toThrow('Obsidian version matrix failed on 1 of 1 version: 1.12.7.');
  });
});
