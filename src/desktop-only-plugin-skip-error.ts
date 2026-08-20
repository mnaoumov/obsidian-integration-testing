/**
 * @file
 *
 * The distinct error thrown when a mobile transport is asked to run integration
 * tests for a plugin whose `manifest.json` says `isDesktopOnly: true`.
 *
 * This is an expected, benign outcome — a desktop-only manifest is a legitimate
 * state, not a misconfiguration — so the error deliberately carries no stack
 * trace. It is thrown rather than returned because the test runner's only way to
 * skip a project's tests is a failing global setup, and a stack trace on an
 * expected skip is what makes a green release run read as broken.
 */

/**
 * Thrown when a desktop-only plugin's mobile integration tests are skipped.
 *
 * Carries the plugin id so a caller can `instanceof`-match and report the skip
 * in its own words.
 */
export class DesktopOnlyPluginSkipError extends Error {
  /**
  The id of the desktop-only plugin whose mobile tests were skipped.
   */
  public readonly pluginId: string;

  /**
   * Creates the error from the plugin id read out of `manifest.json`.
   *
   * @param pluginId - The id of the desktop-only plugin.
   */
  public constructor(pluginId: string) {
    super(
      `Plugin "${pluginId}" has isDesktopOnly: true in manifest.json. `
        + 'Mobile integration tests cannot run for desktop-only plugins, so this project is skipped.'
    );
    this.name = 'DesktopOnlyPluginSkipError';
    this.pluginId = pluginId;
    // An expected skip, not a defect: the message says everything, and a trace pointing into the harness
    // Only suggests the harness broke.
    this.stack = `${this.name}: ${this.message}`;
  }
}
