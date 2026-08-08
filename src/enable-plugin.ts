/**
 * @file
 *
 * Shared helper for enabling an Obsidian plugin with error capture.
 * Used by both the global setup and integration tests.
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import type { Plugin } from 'obsidian';

import type { CommonArguments } from './eval-in-obsidian.ts';

/**
 * Parameters for {@link enablePluginWithErrorCapture}.
 */
export interface EnablePluginParams {
  /**
   * The ID of the plugin to enable.
   */
  readonly pluginId: string;
}

/**
 * Result of enabling a plugin with error capture.
 */
export interface EnablePluginResult {
  /**
   * The error message captured by the `loadPlugin` monkey-patch, or `undefined`
   * when the patch saw no throw. When Obsidian swallows the error *before* the
   * patch (leaving this empty) but the plugin still failed to load, the real
   * cause — if it reached the renderer console — is in {@link EnablePluginResult.rendererConsoleErrors}.
   */
  readonly errorMessage: string | undefined;

  /**
   * Whether the plugin is in the enabled set after the enable attempt.
   * A plugin can be "enabled" (configured) but not "loaded" (failed to initialize).
   */
  readonly isEnabled: boolean;

  /**
   * Whether the plugin instance actually exists in `app.plugins.plugins`.
   * This is the definitive check — a plugin that is enabled but not loaded has failed.
   */
  readonly isLoaded: boolean;

  /**
   * Console/error output captured in the renderer during the enable window —
   * populated **only** when the plugin failed to load and the monkey-patch saw
   * no throw (`!errorMessage && !isLoaded`), i.e. exactly the case that would
   * otherwise surface the generic {@link getGenericPluginLoadFailureMessage} text.
   * `undefined` otherwise (including on success and when {@link EnablePluginResult.errorMessage} already has the error).
   */
  readonly rendererConsoleErrors: string | undefined;
}

interface IntegrationTestingErrorToString {
  errorToString(error: unknown): string;
}

interface IntegrationTestingHolder {
  __obsidianIntegrationTesting: IntegrationTestingErrorToString;
}

/**
 * Enables a plugin inside Obsidian and captures any load error.
 *
 * Monkey-patches `app.plugins.loadPlugin` to intercept errors before
 * Obsidian's `enablePlugin` try-catch swallows them. The original method
 * is always restored in a `finally` block.
 *
 * Designed to be passed as the `callback` argument to {@link evalInObsidian}.
 *
 * @param input - The common input plus the plugin ID.
 * @param input.app - The Obsidian app instance.
 * @param input.pluginId - The ID of the plugin to enable.
 * @returns The enable result with error message and enabled status.
 */
export async function enablePluginWithErrorCapture({ app, pluginId }: CommonArguments & EnablePluginParams): Promise<EnablePluginResult> {
  if (!app.plugins.isEnabled()) {
    await app.plugins.setEnable(true);
  }

  /*
   * Force a genuine reload when retrying. If a prior attempt left the plugin in
   * the enabled set but not loaded (the cold-boot race), a plain re-enable can
   * short-circuit on some Obsidian versions without re-attempting the load.
   * Fully reset the enabled state first so the `enablePluginAndSave` below is a
   * real fresh enable + load. No-op on the first attempt (not yet enabled).
   */
  if (app.plugins.enabledPlugins.has(pluginId) && !Object.hasOwn(app.plugins.plugins, pluginId)) {
    await app.plugins.disablePluginAndSave(pluginId);
  }

  let errorMessage: string | undefined;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Intentional monkey-patch; restored in finally.
  const origLoadPlugin = app.plugins.loadPlugin;
  app.plugins.loadPlugin = async function loadPlugin(id: string, isUserEnabled?: boolean): Promise<Plugin> {
    try {
      const result = await origLoadPlugin.call(this, id, isUserEnabled);
      errorMessage = undefined;
      return result;
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: `__obsidianIntegrationTesting` is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as Partial<IntegrationTestingHolder>;
      errorMessage = holder.__obsidianIntegrationTesting?.errorToString(error) ?? String(error);
      throw error;
    }
  };

  /*
   * Layer 1 — capture the renderer console + uncaught errors for the duration of
   * the enable. If Obsidian swallows the load error before the monkey-patch above
   * sees it (leaving `errorMessage` empty), the real cause is typically still
   * `console.error`'d, so capturing it here surfaces it in place of the generic
   * fallback. Works on desktop and Android alike since this whole function is
   * serialized and injected into the renderer.
   */
  const capturedConsole: string[] = [];
  // eslint-disable-next-line no-restricted-syntax -- Approved double cast, same rationale as above.
  const formatHolder = globalThis as unknown as Partial<IntegrationTestingHolder>;
  function formatArgument(argument: unknown): string {
    if (argument instanceof Error) {
      return formatHolder.__obsidianIntegrationTesting?.errorToString(argument) ?? String(argument);
    }
    if (typeof argument === 'string') {
      return argument;
    }
    if (argument === undefined || argument === null) {
      return String(argument);
    }
    const json = JSON.stringify(argument);
    return json ?? Object.prototype.toString.call(argument);
  }
  function recordConsole(...input: unknown[]): void {
    capturedConsole.push(input.map((argument) => formatArgument(argument)).join(' '));
  }
  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;
  console.error = (...input: unknown[]): void => {
    recordConsole(...input);
    origConsoleError.apply(console, input);
  };
  console.warn = (...input: unknown[]): void => {
    recordConsole(...input);
    origConsoleWarn.apply(console, input);
  };
  function onWindowError(event: ErrorEvent): void {
    capturedConsole.push(event.error instanceof Error ? formatArgument(event.error) : event.message);
  }
  function onUnhandledRejection(event: PromiseRejectionEvent): void {
    capturedConsole.push(formatArgument(event.reason));
  }
  globalThis.addEventListener('error', onWindowError);
  globalThis.addEventListener('unhandledrejection', onUnhandledRejection);

  try {
    await app.plugins.enablePluginAndSave(pluginId);
  } finally {
    // eslint-disable-next-line require-atomic-updates -- Intentional restore of monkey-patch.
    app.plugins.loadPlugin = origLoadPlugin;
    console.error = origConsoleError;
    console.warn = origConsoleWarn;
    globalThis.removeEventListener('error', onWindowError);
    globalThis.removeEventListener('unhandledrejection', onUnhandledRejection);
  }

  const isLoaded = Object.hasOwn(app.plugins.plugins, pluginId);

  let rendererConsoleErrors: string | undefined;
  if (!errorMessage && !isLoaded) {
    const joined = capturedConsole.join('\n').trim();
    rendererConsoleErrors = joined || undefined;
  }

  return {
    errorMessage,
    isEnabled: app.plugins.enabledPlugins.has(pluginId),
    isLoaded,
    rendererConsoleErrors
  };
}

/**
 * The generic last-resort message shown when a plugin is in the enabled set but
 * not loaded and no real error could be captured (neither the `loadPlugin`
 * monkey-patch nor the renderer console nor, on Android, `adb logcat` surfaced a
 * cause).
 *
 * Host-side helper — used by the setup orchestration to compose the final
 * failure message, so the renderer-injected {@link enablePluginWithErrorCapture}
 * stays self-contained.
 *
 * @param pluginId - The ID of the plugin that failed to load.
 * @returns The generic failure message.
 */
export function getGenericPluginLoadFailureMessage(pluginId: string): string {
  return `Plugin "${pluginId}" is in the enabled set but not loaded. `
    + 'Obsidian may have caught the error before the monkey-patch. '
    + 'Check the Obsidian console for details.';
}

/* v8 ignore stop */
