/**
 * @file
 *
 * Manages temporary vault lifecycle for integration tests.
 */

import {
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from 'node:fs';
import {
  readdir,
  readFile,
  rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  relative
} from 'node:path';
import { inject } from 'vitest';

import { getOrCreateTransport } from './transport-factory.ts';
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

  /**
   * Pushes all files from the local staging directory to the target device
   * via the active transport's `pushFiles()`.
   *
   * On desktop transports this is a no-op (files are already local).
   * On mobile transports (Appium) this pushes files to the device.
   *
   * Call this after {@link populate} and before {@link register} when using
   * a mobile transport.
   */
  public async syncToDevice(): Promise<void> {
    const transport = await getOrCreateTransport(inject('obsidianTransport'));
    if (!transport.pushFiles) {
      return;
    }

    const files = await this.collectFiles(this.path);
    await transport.pushFiles(this.path, files);
  }

  /**
   * Recursively reads all files from a directory into a flat map.
   *
   * @param dir - The directory to read.
   * @returns A map of relative file paths to content strings.
   */
  private async collectFiles(dir: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(this.path, fullPath);

      if (entry.isDirectory()) {
        Object.assign(result, await this.collectFiles(fullPath));
      } else {
        result[relativePath] = await readFile(fullPath, 'utf-8');
      }
    }

    return result;
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
