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
import { TEMP_VAULT_DIR_PREFIX } from './leftover-cleanup.ts';
import { log } from './log.ts';
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
 * {@link TemporaryVault.populate}.
 *
 * Paths ending with `/` denote folders and **must** have an `undefined` value.
 * All other paths are written as files.
 */
export type PopulateFilesParams = Record<string, PopulateFileContent>;

/**
 * Options for the {@link TemporaryVault} constructor.
 */
export interface TemporaryVaultOptions {
  /**
   * Whether {@link TemporaryVault.dispose} removes the vault **directory**.
   *
   * When omitted, defaults to whether this instance created that directory — `true` for a temp
   * directory the constructor made (no `path` argument), `false` for a directory handed to it as an
   * explicit `path`. A handle over somebody else's directory unregisters the vault but leaves the
   * files alone, so wrapping a directory cannot destroy it. Set explicitly to override.
   */
  readonly shouldRemoveDirectoryOnDispose?: boolean;
}

const RM_RETRY_DELAY_IN_MILLISECONDS = 500;
const RM_RETRY_TIMEOUT_IN_MILLISECONDS = 10_000;

/**
 * A temporary Obsidian vault for integration tests.
 *
 * Creates a temp directory and registers it in the running Obsidian instance
 * so that the Obsidian CLI can target it via `cwd`.
 *
 * A handle **owns** the directory only when it created it. {@link TemporaryVault.dispose} deletes an
 * owned directory and leaves a borrowed one in place — see
 * {@link TemporaryVaultOptions.shouldRemoveDirectoryOnDispose}, which overrides that default.
 */
export class TemporaryVault {
  /**
   * The absolute path to the temporary vault.
   */
  public readonly path: string;

  /**
   * Whether {@link TemporaryVault.dispose} removes {@link TemporaryVault.path} from disk.
   */
  readonly #shouldRemoveDirectoryOnDispose: boolean;

  /**
   * Creates a new temp vault.
   *
   * @param path - An explicit vault path. If omitted, a temp directory is created.
   * @param options - Vault options.
   */
  public constructor(path?: string, options?: TemporaryVaultOptions) {
    this.path = path ?? mkdtempSync(join(tmpdir(), TEMP_VAULT_DIR_PREFIX));
    this.#shouldRemoveDirectoryOnDispose = options?.shouldRemoveDirectoryOnDispose ?? path === undefined;
  }

  /**
   * Unregisters the vault from Obsidian and, when this handle owns the directory, deletes it.
   *
   * The directory is removed only when this instance created it, or when
   * {@link TemporaryVaultOptions.shouldRemoveDirectoryOnDispose} said so explicitly. That is what
   * makes a handle over a directory somebody else owns — the run's shared setup vault, say, which
   * `getTemporaryVault()` wraps — safe to dispose from a consumer's `afterAll`.
   *
   * @param transportOverride - An explicit transport to use when unregistering.
   *   When omitted, falls back to the transport configured via the context provider.
   */
  public async dispose(transportOverride?: ObsidianTransport): Promise<void> {
    try {
      await unregisterVault(this.path, transportOverride);
    } finally {
      if (this.#shouldRemoveDirectoryOnDispose) {
        await retryRm(this.path);
      } else {
        log(`[temporary-vault] Unregistered but kept the vault directory, which this handle does not own: ${this.path}`);
      }
    }
  }

  /**
   * Writes files and folders into the vault directory **on the host**.
   * Parent directories are created automatically.
   *
   * - `string` values are written as UTF-8 text files.
   * - `Uint8Array` values (including `Buffer`) are written as binary files.
   * - Paths ending with `/` are treated as empty folders (value must be `undefined`).
   *
   * The write is always host-local — {@link TemporaryVault.path} is a host path, and on a mobile
   * transport the vault the app opens lives on the device instead. {@link TemporaryVault.register}
   * carries the directory across before it registers, so populate-then-register is all a caller
   * needs; {@link TemporaryVault.syncToDevice} is the seam that does the carrying.
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
   * Pushes the vault directory to the target device first, via
   * {@link TemporaryVault.syncToDevice} — a no-op on a transport whose app already reads the host
   * filesystem. That ordering used to be the caller's to remember, and a caller who forgot got a
   * silently **empty** vault rather than an error: every pre-registration
   * {@link TemporaryVault.populate} write stayed on the host while the app opened the device's copy.
   * Folding it in here makes populate-then-register correct on every transport.
   *
   * The transport is resolved once and handed to both steps, so a push and the registration that
   * follows it can never land on two different transports.
   *
   * @param transportOverride - An explicit transport to use. When omitted,
   *   falls back to the transport configured via the context provider.
   */
  public async register(transportOverride?: ObsidianTransport): Promise<void> {
    const transport = transportOverride ?? await getOrCreateTransport(getTransportOptions());
    await this.syncToDevice(transport);
    await registerVault(this.path, transport);
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
   * {@link TemporaryVault.register} calls this itself, so a populate-then-register sequence needs
   * nothing extra. Call it directly only to carry across files written **after** registration: the
   * host directory is not mirrored, so a later write into {@link TemporaryVault.path} stays on the
   * host until this runs again.
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
   * @param directory - The directory to read.
   * @returns A map of relative file paths to content buffers.
   */
  private async collectFiles(directory: string): Promise<Record<string, Uint8Array>> {
    const result: Record<string, Uint8Array> = {};
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
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
