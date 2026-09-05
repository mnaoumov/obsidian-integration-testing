/**
 * @file
 *
 * The distinct error thrown when an owned Obsidian instance booted a vault
 * against a **different config folder** than the one requested through
 * `configDirectory` — Obsidian rejected the override, or never saw it, and silently
 * fell back to `.obsidian`.
 *
 * The fallback is silent by construction (`setConfigDir` swaps an invalid value
 * for the default without a word) and the resulting vault looks perfectly
 * healthy: it opens, its layout is ready, and it reports success. What it does
 * not have is the settings, enabled plugins, and workspace of the folder that
 * was asked for — so a suite that verifies behaviour against a real vault's
 * plugin set would silently verify nothing. Hence a hard failure rather than a
 * warning, and, unlike `SilentAsarFallbackError`, no knob to downgrade it: there
 * is no version of this outcome worth continuing against.
 *
 * Exported so callers of `connectToCdp` / the transport can `instanceof`-match
 * this specific failure.
 */

/**
 * Parameters for the {@link ConfigDirectoryFallbackError} constructor.
 */
export interface ConfigDirectoryFallbackErrorConstructorParams {
  /**
  The config folder the vault is actually using, as read back from `app.vault.configDir`.
   */
  readonly actualConfigDirectory: string;

  /**
  The config folder that was requested through `configDirectory`.
   */
  readonly requestedConfigDirectory: string;

  /**
  Absolute path to the vault that was opened.
   */
  readonly vaultPath: string;
}

/**
 * Thrown when a booted owned instance reports a different `app.vault.configDir`
 * than the requested
 * {@link ConfigDirectoryFallbackErrorConstructorParams.requestedConfigDirectory}.
 * Carries both folder names and the vault path so callers can `instanceof`-match
 * and report which vault was opened wrongly.
 */
export class ConfigDirectoryFallbackError extends Error {
  /**
  The config folder the vault is actually using.
   */
  public readonly actualConfigDirectory: string;

  /**
  The config folder that was requested.
   */
  public readonly requestedConfigDirectory: string;

  /**
  Absolute path to the vault that was opened.
   */
  public readonly vaultPath: string;

  /**
   * Creates the error from the requested and actual config folders.
   *
   * @param params - The requested folder, the folder actually in use, and the vault path.
   */
  public constructor(params: ConfigDirectoryFallbackErrorConstructorParams) {
    const { actualConfigDirectory, requestedConfigDirectory, vaultPath } = params;
    super(
      `Vault ${vaultPath} was opened with config folder ${actualConfigDirectory} but ${requestedConfigDirectory} was requested — `
        + 'Obsidian rejected the override or never saw it, and silently fell back. '
        + `Check that ${requestedConfigDirectory} exists in the vault and is a name Obsidian accepts.`
    );
    this.name = 'ConfigDirectoryFallbackError';
    this.actualConfigDirectory = actualConfigDirectory;
    this.requestedConfigDirectory = requestedConfigDirectory;
    this.vaultPath = vaultPath;
  }
}
