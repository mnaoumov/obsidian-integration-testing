/**
 * @file
 *
 * The distinct error thrown when the `dist/` the harness is about to install is
 * **older than the sources it was built from** — the plugin in the vault is not
 * the plugin in the working tree.
 *
 * The failure it prevents has two directions and the cheap one is not the reason
 * this exists. A suite that FAILS against a stale build costs one confusing run:
 * the symptom is whatever the missing code would have provided, so it reads as a
 * defect in the code under test (observed 2026-09-19: a `waitUntil timed out: the
 * enabled event to arrive` against a build five hours old, with the plugin
 * loading and registering perfectly — it simply had no component to publish the
 * event). A suite that PASSES against a stale build costs nothing visible and
 * proves nothing: an integration suite exists to be the one test that can fail
 * for the right reason, and a stale artifact silently converts it into a test of
 * last week's code. Nothing at all reports that direction, which is why the
 * verdict is an error rather than a warning.
 *
 * Exported so a consumer can `instanceof`-match this specific setup failure —
 * the same reason `ConfigDirectoryFallbackError` is.
 */

const MINUTE_IN_MILLISECONDS = 60_000;

/**
 * Parameters for the {@link StaleBuildError} constructor.
 */
export interface StaleBuildErrorConstructorParams {
  /**
  When `main.js` in the chosen dist folder was last written, in epoch milliseconds.
   */
  readonly buildModifiedAtInMilliseconds: number;

  /**
  Absolute path to the dist folder the run was about to install from.
   */
  readonly distPath: string;

  /**
  When the newest source was last written, in epoch milliseconds.
   */
  readonly sourceModifiedAtInMilliseconds: number;

  /**
  Path to the newest source found, relative to the project root.
   */
  readonly sourcePath: string;
}

/**
 * Thrown by the global setup when the built plugin predates its sources.
 *
 * Carries both timestamps and the newest source's path, so the message names the
 * file that makes the build stale rather than leaving the reader to find it.
 */
export class StaleBuildError extends Error {
  /**
  When `main.js` in the chosen dist folder was last written, in epoch milliseconds.
   */
  public readonly buildModifiedAtInMilliseconds: number;

  /**
  Which build is stale and what outdated it, with **no remedy attached** — the opening of
  {@link StaleBuildError.message}, and what the warning path logs when the failure is switched off. The two
  readers need different halves: somebody whose run just FAILED needs the remedy, while somebody who
  deliberately escaped the failure has already applied it, and repeating *"set `shouldFailOnStaleBuild:
  false`"* at a reader who just did exactly that is the noise that teaches people to skim the line.
   */
  public readonly description: string;

  /**
  Absolute path to the dist folder the run was about to install from.
   */
  public readonly distPath: string;

  /**
  When the newest source was last written, in epoch milliseconds.
   */
  public readonly sourceModifiedAtInMilliseconds: number;

  /**
  Path to the newest source found, relative to the project root.
   */
  public readonly sourcePath: string;

  /**
   * Creates the error from the dist folder and the newest source that outdates it.
   *
   * @param params - The dist path, both modification times, and the newest source's path.
   */
  public constructor(params: StaleBuildErrorConstructorParams) {
    const { buildModifiedAtInMilliseconds, distPath, sourceModifiedAtInMilliseconds, sourcePath } = params;
    const ageInMinutes = Math.round((sourceModifiedAtInMilliseconds - buildModifiedAtInMilliseconds) / MINUTE_IN_MILLISECONDS);
    const description = `The build is stale: ${distPath}/main.js was written at ${new Date(buildModifiedAtInMilliseconds).toISOString()}, `
      + `but ${sourcePath} changed at ${new Date(sourceModifiedAtInMilliseconds).toISOString()} — ${String(ageInMinutes)} minute(s) later. `
      + 'The vault would be given a plugin built before that change, so this run tests code that is not in the working tree.';
    super(
      `${description} `
        + 'Run `npm run build` (or `npm run dev`) and try again. '
        + 'To test the built artifact deliberately, set `shouldFailOnStaleBuild: false` in the transport options, '
        + 'or `OBSIDIAN_TEST_ALLOW_STALE_BUILD=1` for a single run.'
    );
    this.name = 'StaleBuildError';
    this.description = description;
    this.buildModifiedAtInMilliseconds = buildModifiedAtInMilliseconds;
    this.distPath = distPath;
    this.sourceModifiedAtInMilliseconds = sourceModifiedAtInMilliseconds;
    this.sourcePath = sourcePath;
  }
}
