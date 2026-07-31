import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { DesktopReleasesManifest } from './obsidian-version.ts';
import type {
  ObsidianVersionMatrixEntry,
  ResolvedVersionSpec
} from './version-matrix.ts';

import {
  CATALYST_LATEST,
  PUBLIC_LATEST
} from './obsidian-version.ts';
import {
  buildVersionMatrix,
  DEFAULT_OBSIDIAN_VERSION_SPECS,
  formatVersionMatrixEntry,
  formatVersionMatrixPlan,
  formatVersionMatrixRunHeader,
  hasChannelSpec,
  parseVersionSpecList,
  resolveRequestedSpecs,
  resolveVersionSpecs,
  runVersionMatrixEntries
} from './version-matrix.ts';

const MANIFEST_DIVERGED: DesktopReleasesManifest = {
  beta: { latestVersion: '1.13.4' },
  latestVersion: '1.12.7'
};

const MANIFEST_CONVERGED: DesktopReleasesManifest = {
  beta: { latestVersion: '1.13.4' },
  latestVersion: '1.13.4'
};

const MANIFEST_NO_BETA: DesktopReleasesManifest = {
  latestVersion: '1.13.4'
};

/**
 * Builds a matrix entry.
 *
 * @param version - The concrete version.
 * @param specs - The specifiers that resolved to it.
 * @returns The entry.
 */
function entry(version: string, ...specs: string[]): ObsidianVersionMatrixEntry {
  return { specs: specs.length === 0 ? [version] : specs, version };
}

/**
 * Builds a resolved specifier.
 *
 * @param spec - The requested specifier.
 * @param version - The version it resolved to.
 * @returns The resolved specifier.
 */
function resolved(spec: string, version: string): ResolvedVersionSpec {
  return { spec, version };
}

describe('DEFAULT_OBSIDIAN_VERSION_SPECS', () => {
  it('should be both ends of the supported range', () => {
    expect(DEFAULT_OBSIDIAN_VERSION_SPECS).toEqual([PUBLIC_LATEST, CATALYST_LATEST]);
  });
});

describe('parseVersionSpecList', () => {
  it('should split a comma-separated list', () => {
    expect(parseVersionSpecList('1.12.7,catalyst-latest')).toEqual(['1.12.7', CATALYST_LATEST]);
  });

  it('should trim surrounding whitespace', () => {
    expect(parseVersionSpecList(' 1.12.7 , catalyst-latest ')).toEqual(['1.12.7', CATALYST_LATEST]);
  });

  it('should drop empty entries', () => {
    expect(parseVersionSpecList('1.12.7,,')).toEqual(['1.12.7']);
  });

  it('should return an empty array for an empty string', () => {
    expect(parseVersionSpecList('')).toEqual([]);
  });

  it('should return an empty array for a whitespace-only string', () => {
    expect(parseVersionSpecList('  ,  ')).toEqual([]);
  });

  it('should return a single specifier unchanged', () => {
    expect(parseVersionSpecList('catalyst-latest')).toEqual([CATALYST_LATEST]);
  });
});

describe('resolveRequestedSpecs', () => {
  it('should fall back to the default list when undefined', () => {
    expect(resolveRequestedSpecs(undefined)).toEqual({ isDefault: true, specs: [PUBLIC_LATEST, CATALYST_LATEST] });
  });

  it('should fall back to the default list for an empty string', () => {
    expect(resolveRequestedSpecs('')).toEqual({ isDefault: true, specs: [PUBLIC_LATEST, CATALYST_LATEST] });
  });

  it('should fall back to the default list for an empty array', () => {
    expect(resolveRequestedSpecs([])).toEqual({ isDefault: true, specs: [PUBLIC_LATEST, CATALYST_LATEST] });
  });

  it('should parse a comma-separated string as explicitly requested', () => {
    expect(resolveRequestedSpecs('1.12.7,catalyst-latest')).toEqual({
      isDefault: false,
      specs: ['1.12.7', CATALYST_LATEST]
    });
  });

  it('should take an array as explicitly requested', () => {
    expect(resolveRequestedSpecs(['1.12.7'])).toEqual({ isDefault: false, specs: ['1.12.7'] });
  });

  it('should not alias the caller array', () => {
    const versions = ['1.12.7'];
    const { specs } = resolveRequestedSpecs(versions);
    versions.push('1.13.4');
    expect(specs).toEqual(['1.12.7']);
  });
});

describe('hasChannelSpec', () => {
  it('should be true when a public alias is present', () => {
    expect(hasChannelSpec(['1.12.7', PUBLIC_LATEST])).toBe(true);
  });

  it('should be true when a catalyst alias is present', () => {
    expect(hasChannelSpec([CATALYST_LATEST])).toBe(true);
  });

  it('should be false for explicit versions only', () => {
    expect(hasChannelSpec(['1.12.7', '1.13.4'])).toBe(false);
  });

  it('should be false for an empty list', () => {
    expect(hasChannelSpec([])).toBe(false);
  });
});

describe('resolveVersionSpecs', () => {
  it('should resolve both channel aliases against the manifest', () => {
    expect(resolveVersionSpecs({
      manifest: MANIFEST_DIVERGED,
      shouldTolerateUnresolvableSpecs: true,
      specs: [PUBLIC_LATEST, CATALYST_LATEST]
    })).toEqual({
      droppedSpecs: [],
      resolvedSpecs: [resolved(PUBLIC_LATEST, '1.12.7'), resolved(CATALYST_LATEST, '1.13.4')]
    });
  });

  it('should resolve both channel aliases to the same version when the channels have converged', () => {
    expect(
      resolveVersionSpecs({
        manifest: MANIFEST_CONVERGED,
        shouldTolerateUnresolvableSpecs: true,
        specs: [PUBLIC_LATEST, CATALYST_LATEST]
      }).resolvedSpecs
    ).toEqual([resolved(PUBLIC_LATEST, '1.13.4'), resolved(CATALYST_LATEST, '1.13.4')]);
  });

  it('should resolve an explicit version without a manifest', () => {
    expect(resolveVersionSpecs({
      manifest: undefined,
      shouldTolerateUnresolvableSpecs: false,
      specs: ['1.8.10']
    })).toEqual({
      droppedSpecs: [],
      resolvedSpecs: [resolved('1.8.10', '1.8.10')]
    });
  });

  it('should throw for a channel alias with no manifest', () => {
    expect(() =>
      resolveVersionSpecs({
        manifest: undefined,
        shouldTolerateUnresolvableSpecs: false,
        specs: [CATALYST_LATEST]
      })
    ).toThrow('Cannot resolve "catalyst-latest" without the desktop releases manifest.');
  });

  it('should throw for an invalid specifier when tolerance is off', () => {
    expect(() =>
      resolveVersionSpecs({
        manifest: MANIFEST_DIVERGED,
        shouldTolerateUnresolvableSpecs: false,
        specs: ['latest']
      })
    ).toThrow('Invalid Obsidian version "latest"');
  });

  it('should throw for a catalyst alias when the manifest has no beta entry and tolerance is off', () => {
    expect(() =>
      resolveVersionSpecs({
        manifest: MANIFEST_NO_BETA,
        shouldTolerateUnresolvableSpecs: false,
        specs: [PUBLIC_LATEST, CATALYST_LATEST]
      })
    ).toThrow('no catalyst');
  });

  it('should drop an unresolvable specifier when tolerance is on', () => {
    expect(resolveVersionSpecs({
      manifest: MANIFEST_NO_BETA,
      shouldTolerateUnresolvableSpecs: true,
      specs: [PUBLIC_LATEST, CATALYST_LATEST]
    })).toEqual({
      droppedSpecs: [{ reason: 'Desktop releases manifest has no catalyst (beta) release.', spec: CATALYST_LATEST }],
      resolvedSpecs: [resolved(PUBLIC_LATEST, '1.13.4')]
    });
  });

  it('should throw when tolerance is on but nothing resolved', () => {
    expect(() =>
      resolveVersionSpecs({
        manifest: MANIFEST_NO_BETA,
        shouldTolerateUnresolvableSpecs: true,
        specs: [CATALYST_LATEST]
      })
    ).toThrow('No Obsidian version could be resolved from: catalyst-latest. catalyst-latest: Desktop releases manifest has no catalyst (beta) release.');
  });

  it('should record why a dropped specifier could not be resolved', () => {
    expect(
      resolveVersionSpecs({
        manifest: MANIFEST_DIVERGED,
        shouldTolerateUnresolvableSpecs: true,
        specs: [PUBLIC_LATEST, 'not-a-version']
      }).droppedSpecs[0]?.reason
    ).toContain('Invalid Obsidian version "not-a-version"');
  });
});

describe('buildVersionMatrix', () => {
  it('should keep distinct versions as separate entries', () => {
    expect(buildVersionMatrix([resolved(PUBLIC_LATEST, '1.12.7'), resolved(CATALYST_LATEST, '1.13.4')])).toEqual([
      entry('1.12.7', PUBLIC_LATEST),
      entry('1.13.4', CATALYST_LATEST)
    ]);
  });

  it('should collapse specifiers that resolve to the same version', () => {
    expect(buildVersionMatrix([resolved(PUBLIC_LATEST, '1.13.4'), resolved(CATALYST_LATEST, '1.13.4')])).toEqual([
      entry('1.13.4', PUBLIC_LATEST, CATALYST_LATEST)
    ]);
  });

  it('should de-duplicate on the resolved version, not the specifier string', () => {
    expect(buildVersionMatrix([resolved('1.13.4', '1.13.4'), resolved(CATALYST_LATEST, '1.13.4')])).toEqual([
      entry('1.13.4', '1.13.4', CATALYST_LATEST)
    ]);
  });

  it('should collapse three specifiers onto two versions, preserving first-seen order', () => {
    expect(buildVersionMatrix([
      resolved(CATALYST_LATEST, '1.13.4'),
      resolved('1.12.7', '1.12.7'),
      resolved(PUBLIC_LATEST, '1.12.7')
    ])).toEqual([
      entry('1.13.4', CATALYST_LATEST),
      entry('1.12.7', '1.12.7', PUBLIC_LATEST)
    ]);
  });

  it('should not repeat an identical specifier on an entry', () => {
    expect(buildVersionMatrix([resolved('1.13.4', '1.13.4'), resolved('1.13.4', '1.13.4')])).toEqual([
      entry('1.13.4', '1.13.4')
    ]);
  });

  it('should return an empty matrix for no specifiers', () => {
    expect(buildVersionMatrix([])).toEqual([]);
  });
});

describe('formatVersionMatrixEntry', () => {
  it('should list the aliases that resolved to the version', () => {
    expect(formatVersionMatrixEntry(entry('1.13.4', PUBLIC_LATEST, CATALYST_LATEST)))
      .toBe('1.13.4 (public-latest, catalyst-latest)');
  });

  it('should omit the parenthetical when the specifier is the version itself', () => {
    expect(formatVersionMatrixEntry(entry('1.13.4', '1.13.4'))).toBe('1.13.4');
  });

  it('should drop a specifier that merely repeats the version', () => {
    expect(formatVersionMatrixEntry(entry('1.13.4', '1.13.4', CATALYST_LATEST))).toBe('1.13.4 (catalyst-latest)');
  });
});

describe('formatVersionMatrixPlan', () => {
  it('should state the collapse explicitly when both ends coincide', () => {
    expect(formatVersionMatrixPlan({
      entries: [entry('1.13.4', PUBLIC_LATEST, CATALYST_LATEST)],
      resolvedSpecs: [resolved(PUBLIC_LATEST, '1.13.4'), resolved(CATALYST_LATEST, '1.13.4')]
    })).toEqual([
      'public-latest -> 1.13.4',
      'catalyst-latest -> 1.13.4',
      '2 requested specifiers resolve to 1 distinct version: 1.13.4 (public-latest, catalyst-latest). Running the suites once.'
    ]);
  });

  it('should announce two runs when the ends diverge', () => {
    expect(formatVersionMatrixPlan({
      entries: [entry('1.12.7', PUBLIC_LATEST), entry('1.13.4', CATALYST_LATEST)],
      resolvedSpecs: [resolved(PUBLIC_LATEST, '1.12.7'), resolved(CATALYST_LATEST, '1.13.4')]
    })).toEqual([
      'public-latest -> 1.12.7',
      'catalyst-latest -> 1.13.4',
      '2 requested specifiers resolve to 2 distinct versions: 1.12.7 (public-latest), 1.13.4 (catalyst-latest). Running the suites twice.'
    ]);
  });

  it('should omit the resolution line for an explicit version', () => {
    expect(formatVersionMatrixPlan({
      entries: [entry('1.8.10', '1.8.10')],
      resolvedSpecs: [resolved('1.8.10', '1.8.10')]
    })).toEqual([
      '1 requested specifier resolves to 1 distinct version: 1.8.10. Running the suites once.'
    ]);
  });

  it('should use a numeric run count beyond two', () => {
    expect(formatVersionMatrixPlan({
      entries: [entry('1.8.10', '1.8.10'), entry('1.12.7', '1.12.7'), entry('1.13.4', '1.13.4')],
      resolvedSpecs: [resolved('1.8.10', '1.8.10'), resolved('1.12.7', '1.12.7'), resolved('1.13.4', '1.13.4')]
    })).toEqual([
      '3 requested specifiers resolve to 3 distinct versions: 1.8.10, 1.12.7, 1.13.4. Running the suites 3 times.'
    ]);
  });
});

describe('formatVersionMatrixRunHeader', () => {
  it('should number the run from one', () => {
    expect(formatVersionMatrixRunHeader({ entry: entry('1.12.7', PUBLIC_LATEST), index: 0, total: 2 }))
      .toBe('Run 1 of 2: 1.12.7 (public-latest)');
  });

  it('should number the last run', () => {
    expect(formatVersionMatrixRunHeader({ entry: entry('1.13.4', CATALYST_LATEST), index: 1, total: 2 }))
      .toBe('Run 2 of 2: 1.13.4 (catalyst-latest)');
  });
});

describe('runVersionMatrixEntries', () => {
  it('should run every entry in order', async () => {
    const seen: string[] = [];
    await runVersionMatrixEntries({
      entries: [entry('1.12.7', PUBLIC_LATEST), entry('1.13.4', CATALYST_LATEST)],
      onEntryStart: () => undefined,
      run: ({ version }) => {
        seen.push(version);
      }
    });
    expect(seen).toEqual(['1.12.7', '1.13.4']);
  });

  it('should report progress for every entry', async () => {
    const onEntryStart = vi.fn();
    await runVersionMatrixEntries({
      entries: [entry('1.12.7', PUBLIC_LATEST), entry('1.13.4', CATALYST_LATEST)],
      onEntryStart,
      run: () => undefined
    });
    expect(onEntryStart).toHaveBeenCalledTimes(2);
    expect(onEntryStart).toHaveBeenNthCalledWith(1, { entry: entry('1.12.7', PUBLIC_LATEST), index: 0, total: 2 });
    expect(onEntryStart).toHaveBeenNthCalledWith(2, { entry: entry('1.13.4', CATALYST_LATEST), index: 1, total: 2 });
  });

  it('should await an asynchronous runner', async () => {
    const seen: string[] = [];
    await runVersionMatrixEntries({
      entries: [entry('1.12.7', PUBLIC_LATEST), entry('1.13.4', CATALYST_LATEST)],
      onEntryStart: () => undefined,
      run: async ({ version }) => {
        await Promise.resolve();
        seen.push(version);
      }
    });
    expect(seen).toEqual(['1.12.7', '1.13.4']);
  });

  it('should refuse an empty matrix rather than silently verifying nothing', async () => {
    await expect(runVersionMatrixEntries({
      entries: [],
      onEntryStart: () => undefined,
      run: () => undefined
    })).rejects.toThrow('Refusing to run an empty Obsidian version matrix');
  });

  it('should keep running the remaining entries after a failure', async () => {
    const seen: string[] = [];
    await expect(runVersionMatrixEntries({
      entries: [entry('1.12.7', PUBLIC_LATEST), entry('1.13.4', CATALYST_LATEST)],
      onEntryStart: () => undefined,
      run: ({ version }) => {
        seen.push(version);
        if (version === '1.12.7') {
          throw new Error('suite failed');
        }
      }
    })).rejects.toThrow('Obsidian version matrix failed on 1 of 2 versions: 1.12.7 (public-latest). Passed: 1.13.4 (catalyst-latest).');
    expect(seen).toEqual(['1.12.7', '1.13.4']);
  });

  it('should omit the passed clause when every entry failed', async () => {
    await expect(runVersionMatrixEntries({
      entries: [entry('1.12.7', PUBLIC_LATEST), entry('1.13.4', CATALYST_LATEST)],
      onEntryStart: () => undefined,
      run: () => {
        throw new Error('suite failed');
      }
    })).rejects.toThrow('Obsidian version matrix failed on 2 of 2 versions: 1.12.7 (public-latest), 1.13.4 (catalyst-latest).');
  });

  it('should carry every underlying failure on the aggregate error', async () => {
    const error = await runVersionMatrixEntries({
      entries: [entry('1.12.7', PUBLIC_LATEST), entry('1.13.4', CATALYST_LATEST)],
      onEntryStart: () => undefined,
      run: ({ version }) => {
        throw new Error(`failed on ${version}`);
      }
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((each: unknown) => (each as Error).message))
      .toEqual(['failed on 1.12.7', 'failed on 1.13.4']);
  });

  it('should use the singular noun for a single-entry matrix', async () => {
    await expect(runVersionMatrixEntries({
      entries: [entry('1.13.4', PUBLIC_LATEST, CATALYST_LATEST)],
      onEntryStart: () => undefined,
      run: () => {
        throw new Error('suite failed');
      }
    })).rejects.toThrow('failed on 1 of 1 version: 1.13.4 (public-latest, catalyst-latest).');
  });
});
