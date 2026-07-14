/**
 * @file
 *
 * The distinct error thrown when a pinned Obsidian installer/Electron shell is
 * too old to run the pinned Obsidian app (asar) version — the resolved installer
 * is below that app version's empirically-measured run floor
 * (`minRunnableInstallerVersion` in `metadata.json`). Unlike
 * `RendererFailedToInitializeError` (which is discovered reactively, after the
 * dead renderer has burned the boot grace window), this is thrown *proactively*
 * from the version-resolution step, before anything is downloaded or launched, so
 * the message can name the installer version that would work.
 */

/**
 * Parameters for the {@link IncompatibleInstallerVersionError} constructor.
 */
export interface IncompatibleInstallerVersionErrorConstructorParams {
  /** The resolved Obsidian app (asar) version that was requested. */
  readonly appVersion: string;

  /** The resolved installer/Electron shell version that is too old to run it. */
  readonly installerVersion: string;

  /** The oldest installer version that can boot {@link appVersion}. */
  readonly minRunnableInstallerVersion: string;
}

/**
 * Thrown when the resolved installer/Electron shell version is below the run
 * floor for the resolved Obsidian app version, so the app could not boot on it.
 * Carries the three versions so callers can `instanceof`-match and surface an
 * actionable remedy.
 */
export class IncompatibleInstallerVersionError extends Error {
  /** The resolved Obsidian app (asar) version that was requested. */
  public readonly appVersion: string;

  /** The resolved installer/Electron shell version that is too old to run it. */
  public readonly installerVersion: string;

  /** The oldest installer version that can boot {@link appVersion}. */
  public readonly minRunnableInstallerVersion: string;

  /**
   * Creates the error from the resolved versions and the run floor.
   *
   * @param params - The requested app version, the too-old installer version,
   *   and the run floor that would work.
   */
  public constructor(params: IncompatibleInstallerVersionErrorConstructorParams) {
    const { appVersion, installerVersion, minRunnableInstallerVersion } = params;
    super(
      `Obsidian installer ${installerVersion} cannot run Obsidian ${appVersion} — `
        + `it needs installer ${minRunnableInstallerVersion} or newer. `
        + 'Pin a newer obsidianInstallerVersion, or align obsidianVersion with the installer.'
    );
    this.name = 'IncompatibleInstallerVersionError';
    this.appVersion = appVersion;
    this.installerVersion = installerVersion;
    this.minRunnableInstallerVersion = minRunnableInstallerVersion;
  }
}
