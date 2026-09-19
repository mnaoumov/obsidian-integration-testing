/**
 * @file
 *
 * Decides whether the `dist/` folder the global setup is about to install
 * predates the sources it was built from, so a run cannot silently test an old
 * plugin. See {@link StaleBuildError} for why this is an error rather than a
 * warning.
 *
 * **What counts as a source.** Everything under `<projectRoot>/src/` that is not
 * a test file, plus `manifest.json` and `styles.css` at the root when they exist.
 * Test files are excluded because they are not build inputs — the bundler's entry
 * graph starts at `src/main.ts` and never reaches a `*.test.ts` — and a guard
 * that fires when editing a test, where rebuilding would change nothing, is a
 * guard people learn to switch off. `package.json` is excluded for the same
 * reason from the other side: it is edited for scripts and dependency ranges far
 * more often than for anything that reaches the bundle, and the one field of it
 * that ships is read back out of `manifest.json` anyway.
 *
 * **mtime, not content.** A `git switch` rewrites mtimes without changing
 * content, so a branch switch can report a stale build against a `dist/` that
 * would hash identically. That direction is deliberate: the remedy is a rebuild,
 * which is what the reader wanted after switching branches anyway, and the
 * alternative — hashing the entry graph — needs the bundler's own input list,
 * which the harness does not have and cannot get from `main.js` in both the
 * `dev` and `build` shapes.
 */

import type { Dirent } from 'node:fs';

import {
  readdir,
  stat
} from 'node:fs/promises';
import {
  join,
  relative,
  sep
} from 'node:path';
import process from 'node:process';

import type { ObsidianTransportOptions } from './transport-options.ts';

/**
 * The environment variable that downgrades a stale-build failure to a warning
 * for a single run.
 *
 * The {@link ObsidianTransportOptions.shouldFailOnStaleBuild} option cannot serve
 * that case on its own: it lives in a tracked config file, so a one-off
 * "test what is in `dist/` right now" run would need an edit and a revert — which
 * is how a guard ends up switched off permanently by accident.
 */
export const ALLOW_STALE_BUILD_ENVIRONMENT_VARIABLE_NAME = 'OBSIDIAN_TEST_ALLOW_STALE_BUILD';

/**
 * Root-level files the plugin build reads besides `src/`.
 */
const ROOT_SOURCE_FILE_NAMES = ['manifest.json', 'styles.css'];

/**
 * The directory holding the plugin's sources, relative to the project root.
 */
const SOURCE_DIRECTORY_NAME = 'src';

/**
 * Directory names never descended into while looking for sources. Neither
 * belongs to a plugin's own `src/`, but both turn up in repos that vendor or
 * generate into it, and either would make the walk arbitrarily expensive.
 */
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);

/**
 * Parameters for {@link checkIsBuildStale}.
 */
export interface CheckIsBuildStaleParams {
  /**
  When `main.js` in the chosen dist folder was last written, in epoch milliseconds.
   */
  readonly buildModifiedAtInMilliseconds: number;

  /**
  The newest source found, or `undefined` when the project has none to compare against.
   */
  readonly newestSource: SourceModification | undefined;
}

/**
 * One source file and when it last changed.
 */
export interface SourceModification {
  /**
  When the file was last written, in epoch milliseconds.
   */
  readonly modifiedAtInMilliseconds: number;

  /**
  The file's path relative to the project root, with `/` separators.
   */
  readonly path: string;
}

/**
 * Decides whether a build predates its sources.
 *
 * `false` when there is no source to compare against: a project whose sources do
 * not live under `src/` is not a project whose build is provably old, and
 * claiming staleness there would fail every run of it.
 *
 * Strictly newer, so a source written in the same millisecond as the build — or
 * by the build itself — is not stale.
 *
 * @param params - The build's modification time and the newest source.
 * @returns `true` when the newest source is newer than the build.
 */
export function checkIsBuildStale(params: CheckIsBuildStaleParams): boolean {
  const { buildModifiedAtInMilliseconds, newestSource } = params;
  return newestSource ? newestSource.modifiedAtInMilliseconds > buildModifiedAtInMilliseconds : false;
}

/**
 * Whether a file name is one the build reads.
 *
 * @param fileName - The bare file name, without a directory.
 * @returns `true` unless it is a test file.
 */
export function checkIsSourceFileName(fileName: string): boolean {
  return !fileName.includes('.test.');
}

/**
 * Finds the most recently modified source of the plugin at `projectRoot`.
 *
 * Walks `src/` recursively and adds the root-level files the build also reads.
 * Anything unreadable is skipped rather than thrown: a file that vanished
 * mid-walk cannot make a build stale, and this check must never be the reason a
 * run fails.
 *
 * @param projectRoot - The absolute path to the project root.
 * @returns The newest source, or `undefined` when the project has none.
 */
export async function findNewestSourceModification(projectRoot: string): Promise<SourceModification | undefined> {
  const paths = [
    ...await listSourcePaths(join(projectRoot, SOURCE_DIRECTORY_NAME)),
    ...ROOT_SOURCE_FILE_NAMES.map((fileName) => join(projectRoot, fileName))
  ];

  let newestSource: SourceModification | undefined;
  for (const path of paths) {
    const modifiedAtInMilliseconds = await readModifiedAtInMilliseconds(path);
    if ((modifiedAtInMilliseconds === undefined) || (newestSource && newestSource.modifiedAtInMilliseconds >= modifiedAtInMilliseconds)) {
      continue;
    }

    newestSource = {
      modifiedAtInMilliseconds,
      path: relative(projectRoot, path).split(sep).join('/')
    };
  }

  return newestSource;
}

/**
 * Resolves whether a stale build fails the run, applying the default when
 * neither escape hatch is used.
 *
 * The environment variable wins over the option, because it is the narrower
 * statement: a project that sets the option has decided permanently, while the
 * variable is set for one command line.
 *
 * @param options - The transport options.
 * @returns `true` when a stale build should throw.
 */
export function willFailOnStaleBuild(options: ObsidianTransportOptions | undefined): boolean {
  return checkIsStaleBuildAllowedByEnvironment() ? false : options?.shouldFailOnStaleBuild ?? true;
}

/**
 * Whether {@link ALLOW_STALE_BUILD_ENVIRONMENT_VARIABLE_NAME} is set to something
 * meaning "yes".
 *
 * An empty value and a literal `0` / `false` count as unset, so a `.env` line
 * left behind as `OBSIDIAN_TEST_ALLOW_STALE_BUILD=0` does not silently keep the
 * guard off.
 *
 * @returns `true` when the variable asks for the guard to be downgraded.
 */
function checkIsStaleBuildAllowedByEnvironment(): boolean {
  const value = process.env[ALLOW_STALE_BUILD_ENVIRONMENT_VARIABLE_NAME]?.trim().toLowerCase() ?? '';
  return value !== '' && value !== '0' && value !== 'false';
}

/**
 * Lists every source file under a directory, recursively.
 *
 * A missing or unreadable directory yields nothing — a project whose sources are
 * elsewhere is not an error here.
 *
 * @param directory - The absolute path to walk.
 * @returns The absolute paths of the source files found.
 */
async function listSourcePaths(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
        paths.push(...await listSourcePaths(path));
      }

      continue;
    }

    if (checkIsSourceFileName(entry.name)) {
      paths.push(path);
    }
  }

  return paths;
}

/**
 * Reads one file's modification time.
 *
 * @param path - The absolute path to stat.
 * @returns The epoch milliseconds, or `undefined` when the file is missing or unreadable.
 */
async function readModifiedAtInMilliseconds(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path);
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}
