/**
 * @file
 *
 * Defines the transport interface for communicating with a running Obsidian instance.
 */

/**
 * A pluggable transport that evaluates JavaScript expressions inside a running
 * Obsidian instance and manages vault lifecycle.
 *
 * Implementations handle the platform-specific details:
 * - {@link DesktopCliTransport} — Desktop Obsidian via CLI (`obsidian eval`)
 * - {@link DesktopCdpTransport} — Desktop Obsidian via Chrome DevTools Protocol
 * - {@link AppiumTransport} — Mobile Obsidian via Appium WebView JS injection
 */
export interface ObsidianTransport {
  /**
   * Disposes of transport resources (e.g. WebSocket connections, Appium sessions).
   */
  dispose?(): Promise<void>;

  /**
   * Synchronous disposal for use in `process.on('exit')` handlers where
   * async work is not possible.
   *
   * Implementations should perform only synchronous cleanup here (e.g. killing
   * child processes). Async operations like unregistering vaults are skipped.
   */
  disposeSync?(): void;

  /**
   * Evaluates a JavaScript expression string inside Obsidian and returns the
   * raw string result.
   *
   * The transport normalizes the output — stripping transport-specific prefixes
   * and handling transport-specific errors — so callers receive a clean result
   * string (e.g. a JSON string, or `(no output)`).
   *
   * @param expression - A self-contained JavaScript expression (typically an async IIFE).
   * @param options - Evaluation options including the working directory.
   * @returns The raw result string from Obsidian.
   */
  evaluate(expression: string, options: TransportEvalOptions): Promise<string>;

  /**
   * Whether this transport targets a mobile Obsidian instance.
   *
   * When `true`, desktop-only plugins (with `isDesktopOnly: true` in manifest)
   * will refuse to run integration tests.
   */
  isMobile: boolean;

  /**
   * Runs transport-specific preflight checks before evaluation.
   *
   * For example, the CLI transport verifies that the vault is registered,
   * the CLI is enabled, and the CLI binary is in PATH.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  preflightCheck(vaultPath: string): Promise<void>;

  /**
   * Pushes files into a vault directory on the target device.
   *
   * On desktop this is a no-op (files are written to the local filesystem directly).
   * On mobile this uses the device's file transfer mechanism (e.g. Appium `pushFile`).
   *
   * @param vaultPath - The absolute path to the vault folder.
   * @param files - Map of relative file paths to content strings.
   */
  pushFiles?(vaultPath: string, files: Record<string, string>): Promise<void>;

  /**
   * Registers a vault path so Obsidian can target it.
   *
   * On desktop: uses Electron IPC to open the vault and polls for readiness.
   * On mobile: pushes vault files to the device and restarts the app.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  registerVault(vaultPath: string): Promise<void>;

  /**
   * Unregisters a vault path from the running Obsidian instance.
   *
   * On desktop: closes the vault window and removes it from the registry.
   * On mobile: removes vault files from the device.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  unregisterVault(vaultPath: string): Promise<void>;
}

/**
 * Options for {@link ObsidianTransport.evaluate}.
 */
export interface TransportEvalOptions {
  /**
   * The working directory (vault path) for the evaluation.
   */
  readonly cwd: string;

  /**
   * Timeout in milliseconds for the evaluation command.
   */
  readonly timeoutInMilliseconds?: number;
}
