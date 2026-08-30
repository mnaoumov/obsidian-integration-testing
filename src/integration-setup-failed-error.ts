/**
 * @file
 *
 * The distinct error thrown in a **test worker** when that project's integration
 * global setup already failed in the main process.
 *
 * Without it a worker whose setup failed gets no transport options at all, and
 * silently rebuilds the owned **desktop** CDP default — so an Android project's
 * suite would run on desktop, and then die on `Failed to parse URL from /json`
 * (an owned instance nobody launched has no CDP endpoint). Every file in the
 * project reported that mask while the real cause appeared once, far above, in
 * the setup log. This error replaces the mask: it is raised before any transport
 * is constructed, and it carries the original setup failure verbatim, so each
 * report names the actual cause.
 *
 * It deliberately carries no stack trace: the failure happened in the global
 * setup, which already logged its own trace, and a second trace pointing into
 * the harness only suggests the harness broke.
 */

/**
 * Parameters for the {@link IntegrationSetupFailedError} constructor. This is also the
 * shape the framework adapter publishes to its workers (Vitest: `provide('setupError')`).
 */
export interface IntegrationSetupFailedErrorConstructorParams {
  /**
  The `name` of the original error the global setup threw, so a caller can tell an
  expected skip (`DesktopOnlyPluginSkipError`) from a real breakage without the
  original error object, which does not survive the trip to a worker.
   */
  readonly errorName: string;

  /**
  The original setup failure, already stringified by the adapter that caught it.
   */
  readonly message: string;

  /**
  The transport the failed project is configured for (e.g. `obsidian-android-appium`),
  so the report names the platform the suite was meant to run on.
   */
  readonly transportLabel: string;
}

/**
 * Thrown when a test worker asks for the ambient transport of a project whose
 * global setup failed. Carries the configured transport, the original error's
 * `name`, and its message, so callers can `instanceof`-match and report the real
 * cause instead of a downstream transport error.
 */
export class IntegrationSetupFailedError extends Error {
  /**
  The `name` of the original error the global setup threw.
   */
  public readonly errorName: string;

  /**
  The original setup failure, as stringified by the adapter that caught it.
   */
  public readonly originalMessage: string;

  /**
  The transport the failed project is configured for.
   */
  public readonly transportLabel: string;

  /**
   * Creates the error from the failure the global setup published to its workers.
   *
   * @param params - The configured transport plus the original error's name and message.
   */
  public constructor(params: IntegrationSetupFailedErrorConstructorParams) {
    const {
      errorName,
      message,
      transportLabel
    } = params;
    super(
      `Integration setup for transport "${transportLabel}" failed, so its tests cannot run. `
        + `Original error: ${message}`
    );
    this.name = 'IntegrationSetupFailedError';
    this.errorName = errorName;
    this.originalMessage = message;
    this.transportLabel = transportLabel;
    // The global setup already logged the original failure with its own trace. A second trace, pointing
    // At the harness internals that merely re-raised it, is what makes the real cause hard to find.
    this.stack = `${this.name}: ${this.message}`;
  }
}
