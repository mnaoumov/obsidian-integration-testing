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

import type { ObsidianTransport } from './transport.ts';

import { getTransportOptions } from './context-provider.ts';
import { getOrCreateTransport } from './transport-factory.ts';
import {
  registerVault,
  unregisterVault
} from './vault-registry.ts';

/**
 * Content value for a single entry in a {@link PopulateFiles} map.
 *
 * - `string` — text file (written as UTF-8).
 * - `Uint8Array` — binary file (written as raw bytes; `Buffer` is accepted
 *   because `Buffer extends Uint8Array`).
 * - `undefined` — empty folder (the key **must** end with `/`).
 */
export type PopulateFileContent = string | Uint8Array | undefined;

/**
 * A map of vault-relative paths to their content, used by
 * {@link TempVault.populate}.
 *
 * Paths ending with `/` denote folders and **must** have an `undefined` value.
 * All other paths are written as files.
 */
export type PopulateFilesParams = Record<string, PopulateFileContent>;

const RM_RETRY_DELAY_IN_MILLISECONDS = 500;
const RM_RETRY_TIMEOUT_IN_MILLISECONDS = 10000;

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
   *
   * @param transportOverride - An explicit transport to use when unregistering.
   *   When omitted, falls back to the transport configured via the context provider.
   */
  public async dispose(transportOverride?: ObsidianTransport): Promise<void> {
    try {
      await unregisterVault(this.path, transportOverride);
    } finally {
      await retryRm(this.path);
    }
  }

  /**
   * Writes files and folders into the vault directory.
   * Parent directories are created automatically.
   *
   * - `string` values are written as UTF-8 text files.
   * - `Uint8Array` values (including `Buffer`) are written as binary files.
   * - Paths ending with `/` are treated as empty folders (value must be `undefined`).
   *
   * @param files - Map of file/folder paths to content.
   */
  public populate(files: PopulateFilesParams): void {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(this.path, filePath);
      if (filePath.endsWith('/')) {
        if (content !== undefined) {
          throw new Error(`Folder path "${filePath}" must have undefined content`);
        }
        mkdirSync(fullPath, { recursive: true });
      } else {
        if (content === undefined) {
          throw new Error(`File path "${filePath}" must have defined content; use a trailing "/" for folders`);
        }
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
    }
  }

  /**
   * Registers this vault in the running Obsidian instance so the CLI can target it.
   *
   * @param transportOverride - An explicit transport to use. When omitted,
   *   falls back to the transport configured via the context provider.
   */
  public async register(transportOverride?: ObsidianTransport): Promise<void> {
    await registerVault(this.path, transportOverride);
  }

  /**
   * Async disposable support for `await using`.
   *
   * @returns A promise that resolves when the vault is disposed.
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  /* v8 ignore start -- Integration-time code that requires a running transport. */

  /**
   * Pushes all files from the local staging directory to the target device
   * via the active transport's `pushFiles()`.
   *
   * On desktop transports this is a no-op (files are already local).
   * On mobile transports (Appium) this pushes files to the device.
   *
   * Call this after {@link populate} and before {@link register} when using
   * a mobile transport.
   *
   * @param transportOverride - An explicit transport to use. When omitted,
   *   falls back to the transport configured via the context provider.
   */
  public async syncToDevice(transportOverride?: ObsidianTransport): Promise<void> {
    const transport = transportOverride ?? await getOrCreateTransport(getTransportOptions());
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
   * @returns A map of relative file paths to content buffers.
   */
  private async collectFiles(dir: string): Promise<Record<string, Uint8Array>> {
    const result: Record<string, Uint8Array> = {};
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(this.path, fullPath);

      if (entry.isDirectory()) {
        Object.assign(result, await this.collectFiles(fullPath));
      } else {
        result[relativePath] = await readFile(fullPath);
      }
    }

    return result;
  }
  /* v8 ignore stop */
}

/**
 * Retries `rm` until it succeeds or times out.
 * Obsidian may hold file locks briefly after a window is destroyed.
 *
 * @param path - The path to the directory to remove.
 * @returns A promise that resolves when the directory is removed.
 */
async function retryRm(path: string): Promise<void> {
  const deadline = Date.now() + RM_RETRY_TIMEOUT_IN_MILLISECONDS;
  while (Date.now() < deadline) {
    try {
      await rm(path, { force: true, recursive: true });
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, RM_RETRY_DELAY_IN_MILLISECONDS);
      });
    }
  }
  // Final attempt — let it throw.
  await rm(path, { force: true, recursive: true });
}
