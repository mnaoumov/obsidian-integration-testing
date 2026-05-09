/**
 * @file
 *
 * Type definitions for the `window.__obsidianIntegrationTesting` namespace
 * used inside the Obsidian process. All library state and registered helper
 * functions live under this single namespace to avoid polluting `window`.
 */

/**
 * Parameters for the registered `evalWrapper` function.
 */
export interface EvalWrapperNamespaceParams {
  /** User-supplied arguments to pass to `fn`. */
  args: Record<string, unknown>;
  /** Optional context ID for persistent storage. */
  contextId?: string;
  /** The user function to evaluate. */
  fn(args: Record<string, unknown>): unknown;
}

/**
 * Parameters for {@link ObsidianIntegrationTestingNamespace.ipcSendSync}.
 */
export interface IpcSendSyncNamespaceParams {
  /** The IPC arguments. */
  args: unknown[];
  /** The IPC channel name. */
  channel: string;
}

/**
 * Holder interface for type-safe access to `window.__obsidianIntegrationTesting`.
 * Use with `Partial<ObsidianIntegrationTestingHolder>` to safely check existence.
 */
export interface ObsidianIntegrationTestingHolder {
  __obsidianIntegrationTesting: ObsidianIntegrationTestingNamespace;
}

/**
 * The namespace object stored on `window.__obsidianIntegrationTesting`
 * inside the Obsidian process. Registered once via {@link bootstrapNamespace}
 * and reused across all subsequent `evalInObsidian` calls.
 *
 * All functions access `window.app` directly — callers do not need to pass it.
 */
export interface ObsidianIntegrationTestingNamespace {
  /**
   * Persistent context objects keyed by {@link ContextId} string.
   * Preserved across version upgrades so live context references survive.
   */
  contexts: Record<string, Record<string, unknown>>;

  /**
   * Destroys the current Electron window.
   */
  destroyCurrentWindow(): Promise<void>;

  /**
   * Waits for the Obsidian workspace layout to be ready.
   */
  ensureLayoutReady(): Promise<void>;

  /**
   * The top-level wrapper that sets up context, resolves the obsidian module,
   * calls the user's function, and returns a JSON envelope.
   *
   * @param params - Parameters including the user's function, args, and context ID.
   * @returns A JSON-stringified result envelope.
   */
  evalWrapper(params: EvalWrapperNamespaceParams): Promise<string>;

  /**
   * Resolves the `obsidian` module at runtime inside the Obsidian process.
   *
   * @returns The `obsidian` module.
   */
  getObsidianModule(): Promise<unknown>;

  /**
   * Sends an IPC message synchronously via Electron's `ipcRenderer`.
   *
   * @param params - The IPC channel and arguments.
   */
  ipcSendSync(params: IpcSendSyncNamespaceParams): Promise<void>;

  /**
   * Cached `obsidian` module, set by {@link getObsidianModule} on first resolution.
   */
  obsidianModule?: unknown;

  /**
   * Returns the vault's base path as a JSON-encoded string.
   *
   * @returns The JSON-encoded base path.
   */
  pollVaultBasePath(): Promise<string>;

  /**
   * Serializes an error into a human-readable string with stack trace and cause chain.
   *
   * @param error - The error to serialize.
   * @param depth - The current nesting depth.
   * @returns A formatted error string.
   */
  serializeError(error: unknown, depth?: number): string;

  /**
   * Sets a `localStorage` item.
   *
   * @param params - The key and value to set.
   */
  setLocalStorageItem(params: SetLocalStorageItemNamespaceParams): Promise<void>;

  /**
   * The library version that was used to bootstrap this namespace.
   * Used to detect version mismatches and re-initialize.
   */
  version: string;
}

/**
 * Parameters for {@link ObsidianIntegrationTestingNamespace.setLocalStorageItem}.
 */
export interface SetLocalStorageItemNamespaceParams {
  /** The localStorage key. */
  key: string;
  /** The localStorage value. */
  value: string;
}
