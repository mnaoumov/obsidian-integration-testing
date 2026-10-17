/**
 * @file
 *
 * Re-writes a file Obsidian on the Android emulator wrote as EMPTY, so a suite
 * tests its plugin rather than the emulator's storage.
 *
 * About one `vault.create` in a hundred on the emulator leaves a 0-byte file
 * behind, with no community plugin enabled but the harness's own (measured
 * 2026-10-17 in `obsidian-advanced-rename-and-delete-handler`: 4 of 480 writes
 * with that plugin disabled). The loss stays: `adapter.stat` still reads 0 bytes
 * 1.4 s later, and asking the adapter to reconcile the file changes nothing.
 * Obsidian registers the file from that stat, indexes the empty content, and no
 * later event makes it look again, so an index precondition the suite waits on
 * (`getBacklinksForFile`, the canvas index, frontmatter) never comes true. A run
 * creates about a hundred files, so about one wait per run timed out, in a
 * different suite each time, before any plugin code had run.
 *
 * The guard wraps the adapter's `write` and `writeBinary`. When the file on disk
 * is EMPTY although the data was not, it writes the same data again; the adapter
 * then sees the size change, reports a modification, and Obsidian re-indexes the
 * file. It acts only on that one shape: a size that merely differs could be a
 * later write to the same path that landed in between, and writing the old data
 * over it would corrupt the file.
 *
 * Both renderer functions are serialized by `browser.execute`, so they read
 * `globalThis` and nothing from module scope.
 */

import type { DataAdapter } from 'obsidian';

/**
 * What {@link installAndroidWriteLossGuard} did.
 */
export type AndroidWriteLossGuardInstallResult = 'already-installed' | 'installed' | 'no-vault-adapter';

/**
 * The rewrites the guard made since they were last drained, one line each.
 */
export type AndroidWriteLossRewrites = string[];

interface WriteLossGuardApp {
  vault?: WriteLossGuardVault;
}

// Kept local rather than declared globally, like every other holder of a
// harness `window` property, so it never leaks into consumer types.
interface WriteLossGuardHolder {
  __obsidianIntegrationTestingWriteLossGuard?: WriteLossGuardState;
  app?: WriteLossGuardApp;
}

interface WriteLossGuardState {
  rewrites: AndroidWriteLossRewrites;
}

interface WriteLossGuardVault {
  adapter?: DataAdapter;
}

/**
 * Builds the line a run logs for the rewrites the guard made, if it made any.
 *
 * @param rewrites - What {@link drainAndroidWriteLossRewrites} returned. Typed
 * `unknown` because it crossed the WebDriver boundary, where nothing checks it.
 * @returns The line to log, or `undefined` when nothing was re-written.
 */
export function buildAndroidWriteLossReport(rewrites: unknown): string | undefined {
  return !Array.isArray(rewrites) || rewrites.length === 0 ? undefined : `[android-write-loss-guard] Re-wrote ${String(rewrites.length)} file(s) the emulator wrote empty: ${rewrites.join('; ')}`;
}

/**
 * Returns the rewrites the guard made since the last call, and forgets them.
 *
 * Runs in the renderer, through `browser.execute`.
 *
 * @returns The rewrites, empty when the guard is not installed.
 */
export function drainAndroidWriteLossRewrites(this: void): AndroidWriteLossRewrites {
  const state = (globalThis as WriteLossGuardHolder).__obsidianIntegrationTestingWriteLossGuard;
  if (!state) {
    return [];
  }

  const taken = state.rewrites;
  state.rewrites = [];
  return taken;
}

/**
 * Wraps the vault adapter's `write` and `writeBinary` so a write that lands
 * empty is written again. Once per page: a second call is a no-op.
 *
 * Runs in the renderer, through `browser.execute`.
 *
 * @returns What this call did.
 */
export function installAndroidWriteLossGuard(this: void): AndroidWriteLossGuardInstallResult {
  const holder = globalThis as WriteLossGuardHolder;
  if (holder.__obsidianIntegrationTestingWriteLossGuard) {
    return 'already-installed';
  }

  const adapter = holder.app?.vault?.adapter;
  if (!adapter) {
    return 'no-vault-adapter';
  }

  const state: WriteLossGuardState = { rewrites: [] };
  holder.__obsidianIntegrationTestingWriteLossGuard = state;

  const originalWrite = adapter.write.bind(adapter);
  const originalWriteBinary = adapter.writeBinary.bind(adapter);
  // One rewrite has always been enough; the second is there so a repeat loss is reported, not looped on.
  const MAX_REWRITES = 2;

  async function rewriteIfLost(target: DataAdapter, path: string, byteLength: number, rewrite: () => Promise<void>): Promise<void> {
    if (byteLength === 0) {
      return;
    }

    for (let attempt = 1; attempt <= MAX_REWRITES; attempt++) {
      const stat = await target.stat(path);
      if (stat?.size !== 0) {
        return;
      }

      state.rewrites.push(`${path} (${String(byteLength)} bytes, attempt ${String(attempt)})`);
      await rewrite();
    }
  }

  adapter.write = async (path, data, options): Promise<void> => {
    await originalWrite(path, data, options);
    await rewriteIfLost(adapter, path, new TextEncoder().encode(data).byteLength, () => originalWrite(path, data, options));
  };

  adapter.writeBinary = async (path, data, options): Promise<void> => {
    await originalWriteBinary(path, data, options);
    await rewriteIfLost(adapter, path, data.byteLength, () => originalWriteBinary(path, data, options));
  };

  return 'installed';
}
