/**
 * @file
 *
 * The distinct error thrown when the owned Obsidian renderer terminally fails to
 * initialize — the asar could not run on the launched Electron shell (the
 * installer/Electron version is too old for the Obsidian app version). It is
 * exported so callers of `connectToCdp` / the transport can `instanceof`-match
 * this specific failure and distinguish it from a generic readiness timeout.
 */

/**
 * Thrown when the owned Obsidian renderer loads but never bootstraps the app —
 * an empty `<body>` with no `window.app` after the boot grace window (see
 * `checkRendererBootState`). The usual cause is an installer/Electron shell too
 * old for the pinned Obsidian app version.
 */
export class RendererFailedToInitializeError extends Error {
  /**
   * Creates the error for a specific vault.
   *
   * @param vaultPath - The vault whose owned renderer failed to initialize.
   */
  public constructor(vaultPath: string) {
    super(
      `The Obsidian renderer for vault ${vaultPath} did not initialize on this Electron shell. `
        + 'The installer/Electron version is likely too old for this Obsidian app version. '
        + 'Pin a newer obsidianInstallerVersion, or align obsidianVersion with the installed shell.'
    );
    this.name = 'RendererFailedToInitializeError';
  }
}
