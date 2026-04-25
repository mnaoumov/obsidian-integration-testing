/**
 * @file
 *
 * Shared helper for enabling an Obsidian plugin with error capture.
 * Used by both the global setup and integration tests.
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import type { Plugin } from 'obsidian';

import type { CommonArgs } from './obsidian-cli.ts';

/**
 * Parameters for {@link enablePluginWithErrorCapture}.
 */
export interface EnablePluginParams {
  /**
   * The ID of the plugin to enable.
   */
  pluginId: string;
}

/**
 * Result of enabling a plugin with error capture.
 */
export interface EnablePluginResult {
  /**
   * The error message if the plugin failed to load, or `undefined` if it loaded successfully.
   */
  errorMessage: string | undefined;

  /**
   * Whether the plugin is in the enabled set after the enable attempt.
   */
  isEnabled: boolean;
}

/**
 * Injected into the IIFE scope by {@link evalInObsidian} at runtime.
 * Not importable — exists only inside the generated expression.
 *
 * @param error - The error to serialize.
 * @returns A formatted error string with stack trace and cause chain.
 */
declare function serializeError(error: unknown): string;

/**
 * Enables a plugin inside Obsidian and captures any load error.
 *
 * Monkey-patches `app.plugins.loadPlugin` to intercept errors before
 * Obsidian's `enablePlugin` try-catch swallows them. The original method
 * is always restored in a `finally` block.
 *
 * Designed to be passed as the `fn` argument to {@link evalInObsidian}.
 *
 * @param args - The common args plus the plugin ID.
 * @param args.app - The Obsidian app instance.
 * @param args.pluginId - The ID of the plugin to enable.
 * @returns The enable result with error message and enabled status.
 */
export async function enablePluginWithErrorCapture({ app, pluginId }: CommonArgs & EnablePluginParams): Promise<EnablePluginResult> {
  if (!app.plugins.isEnabled()) {
    await app.plugins.setEnable(true);
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
      errorMessage = serializeError(error);
      throw error;
    }
  };

  try {
    await app.plugins.enablePluginAndSave(pluginId);
  } finally {
    // eslint-disable-next-line require-atomic-updates -- Intentional restore of monkey-patch.
    app.plugins.loadPlugin = origLoadPlugin;
  }

  return {
    errorMessage,
    isEnabled: app.plugins.enabledPlugins.has(pluginId)
  };
}

/* v8 ignore stop */
