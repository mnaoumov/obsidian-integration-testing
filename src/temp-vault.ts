/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

/**
 * @packageDocumentation
 *
 * Manages temporary vault lifecycle for integration tests.
 */

import {
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  join
} from 'node:path';

import {
  registerVault,
  unregisterVault
} from './vault-registry.ts';

const RM_RETRY_DELAY_MS = 500;
const RM_RETRY_TIMEOUT_MS = 10000;

/**
 * A temporary Obsidian vault for integration tests.
 *
 * Creates a temp directory and registers it in the running Obsidian instance
 * so that the Obsidian CLI can target it via `cwd`.
 */
export class TempVault {
  /**
   * The absolute path to the temporary vault.
   */
  public readonly path: string;

  /**
   * Creates a new temp vault.
   *
   * @param path - An explicit vault path. If omitted, a temp directory is created.
   */
  public constructor(path?: string) {
    this.path = path ?? mkdtempSync(join(tmpdir(), 'temp-vault-'));
  }

  /**
   * Unregisters the vault from Obsidian and deletes the temp directory.
   */
  public async dispose(): Promise<void> {
    await unregisterVault(this.path);
    await retryRm(this.path);
  }

  /**
   * Writes files and folders into the vault directory.
   * Parent directories are created automatically.
   * Paths ending with `/` are treated as empty folders (content must be empty string).
   *
   * @param files - Map of file/folder paths to content.
   */
  public populate(files: Record<string, string>): void {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(this.path, filePath);
      if (filePath.endsWith('/')) {
        if (content !== '') {
          throw new Error(`Folder path "${filePath}" must have empty content`);
        }
        mkdirSync(fullPath, { recursive: true });
      } else {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
    }
  }

  /**
   * Registers this vault in the running Obsidian instance so the CLI can target it.
   */
  public async register(): Promise<void> {
    await registerVault(this.path);
  }

  /**
   * Async disposable support for `await using`.
   *
   * @returns A promise that resolves when the vault is disposed.
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}

/**
 * Retries `rm` until it succeeds or times out.
 * Obsidian may hold file locks briefly after a window is destroyed.
 *
 * @param path - The path to the directory to remove.
 * @returns A promise that resolves when the directory is removed.
 */
async function retryRm(path: string): Promise<void> {
  const deadline = Date.now() + RM_RETRY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await rm(path, { force: true, recursive: true });
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, RM_RETRY_DELAY_MS);
      });
    }
  }
  // Final attempt — let it throw.
  await rm(path, { force: true, recursive: true });
}
