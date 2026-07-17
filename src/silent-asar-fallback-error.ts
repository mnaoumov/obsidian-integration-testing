/**
 * @file
 *
 * The distinct error thrown when a booted owned Obsidian instance is **not**
 * running the pinned app (asar) version — the installer shell silently fell back
 * to its own bundled asar instead of running the swapped-in pin (see
 * `asar-fallback-detection`). Unlike `RendererFailedToInitializeError` (a
 * black-screen dead boot) this fires on a *healthy* renderer running the wrong
 * (older) version, so it is discovered post-boot from the live running version
 * rather than from an empty `<body>`. It is exported so callers of `connectToCdp`
 * / the transport can `instanceof`-match this specific failure.
 */

/**
 * Parameters for the {@link SilentAsarFallbackError} constructor.
 */
export interface SilentAsarFallbackErrorConstructorParams {
  /** The pinned Obsidian app (asar) version that was requested. */
  readonly requestedVersion: string;

  /** The Obsidian app (asar) version the instance is actually running. */
  readonly runningApiVersion: string;
}

/**
 * Thrown when a booted owned instance is running a different app (asar) version
 * than the pinned {@link SilentAsarFallbackErrorConstructorParams.requestedVersion} —
 * the installer shell was too old for the pin and silently reverted to its own
 * bundled asar. Carries both versions so callers can `instanceof`-match and
 * surface an actionable remedy (pin a newer installer).
 */
export class SilentAsarFallbackError extends Error {
  /** The pinned Obsidian app (asar) version that was requested. */
  public readonly requestedVersion: string;

  /** The Obsidian app (asar) version the instance is actually running. */
  public readonly runningApiVersion: string;

  /**
   * Creates the error from the pinned and actually-running versions.
   *
   * @param params - The requested pin and the version actually running.
   */
  public constructor(params: SilentAsarFallbackErrorConstructorParams) {
    const { requestedVersion, runningApiVersion } = params;
    super(
      `Obsidian was pinned to app version ${requestedVersion} but is actually running ${runningApiVersion} — `
        + 'the installer shell is too old for the pin and silently fell back to its own bundled asar. '
        + `Pin an obsidianInstallerVersion at or above ${requestedVersion}'s run floor so the pinned version runs.`
    );
    this.name = 'SilentAsarFallbackError';
    this.requestedVersion = requestedVersion;
    this.runningApiVersion = runningApiVersion;
  }
}
