/**
 * @file
 *
 * Pure matching of a probed vault base path against a requested vault path.
 *
 * The desktop CDP transport routes an `evalInObsidian` call to the correct
 * Obsidian window by probing each target's `app.vault.adapter.getBasePath()` and
 * comparing it to the requested vault path. That comparison must tolerate benign
 * formatting differences between the renderer-reported base path and the
 * Node-side path (path-separator flavor, and case on case-insensitive
 * filesystems), so it lives here as a pure, unit-tested helper rather than as a
 * raw `===` inside the integration-only transport module (which is excluded from
 * unit tests).
 */

import process from 'node:process';

/**
 * Whether the host filesystem compares paths case-insensitively. Windows (and, in
 * practice, the default macOS volume) are case-insensitive; treat only Windows as
 * such by default, matching where the harness runs.
 */
const IS_CASE_INSENSITIVE_FILESYSTEM = process.platform === 'win32';

/**
 * Normalizes a vault path for comparison: unifies path separators to `/`, strips
 * any trailing separators, and (on a case-insensitive filesystem) lowercases it.
 *
 * @param path - The path to normalize.
 * @param isCaseInsensitive - Whether to compare case-insensitively. Defaults to
 *   the host filesystem's behavior (case-insensitive on Windows).
 * @returns The normalized path.
 */
export function normalizeVaultPathForComparison(path: string, isCaseInsensitive = IS_CASE_INSENSITIVE_FILESYSTEM): string {
  const unifiedSeparators = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return isCaseInsensitive ? unifiedSeparators.toLowerCase() : unifiedSeparators;
}

/**
 * Whether a probed base path and a requested vault path refer to the same vault,
 * comparing via {@link normalizeVaultPathForComparison} so separator-flavor and
 * (on case-insensitive filesystems) case differences do not cause a false miss.
 *
 * @param basePath - The base path probed from an Obsidian target.
 * @param vaultPath - The requested vault path.
 * @param isCaseInsensitive - Whether to compare case-insensitively. Defaults to
 *   the host filesystem's behavior (case-insensitive on Windows).
 * @returns `true` when the two paths refer to the same vault.
 */
export function vaultPathsMatch(basePath: string, vaultPath: string, isCaseInsensitive = IS_CASE_INSENSITIVE_FILESYSTEM): boolean {
  return normalizeVaultPathForComparison(basePath, isCaseInsensitive) === normalizeVaultPathForComparison(vaultPath, isCaseInsensitive);
}
