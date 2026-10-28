/**
 * @file
 *
 * Pure helpers that tell apart the ways a WebView probe can fail while the
 * Appium transport waits out Obsidian Mobile's startup.
 *
 * The startup poll used to read every failed probe as "the WebView cannot
 * answer yet", which is right while the page is mid-`location.reload()` and
 * wrong in two cases that never get better by waiting:
 *
 * - **The session is gone.** Appium answers `A session is either terminated or
 *   not started` (W3C `invalid session id`) for every later command, so the
 *   poll spent the whole 180s app-start budget on a session that had already
 *   ended, and the timeout named neither the session nor the cause.
 * - **ChromeDriver's window is gone.** The page target ChromeDriver is attached
 *   to was replaced, so every command answers `no such window: target window
 *   already closed` / `web view not found`. Re-switching to the same
 *   `WEBVIEW_md.obsidian` context does not help: Appium treats a switch to the
 *   current context as a no-op and ChromeDriver keeps the dead handle, which is
 *   exactly what the retained logs showed for minutes on end.
 *
 * Kept separate from the integration-only `transport-appium` (excluded from
 * unit tests) so the classification and the message stay unit-testable.
 */

import { errorToString } from '../error-to-string.ts';

/**
 * Parameters for {@link buildSessionTerminatedMessage}.
 */
export interface BuildSessionTerminatedMessageParams {
  /**
  The device-side vault the startup was waiting for.
   */
  readonly deviceVaultPath: string;

  /**
  How long the phase had been running when the session was found gone.
   */
  readonly elapsedInMilliseconds: number;

  /**
  The error the probe failed with.
   */
  readonly error: unknown;

  /**
  The startup phase that was being waited out.
   */
  readonly phase: string;
}

/**
 * What a failed WebView probe says about the session behind it.
 *
 * - `session-terminated` — the WebDriver session no longer exists; permanent.
 * - `window-closed` — ChromeDriver is attached to a page target that is gone;
 *   recoverable by attaching to a live window.
 * - `other` — anything else, including a WebView that cannot answer yet.
 */
export type WebViewProbeFailure = 'other' | 'session-terminated' | 'window-closed';

const SESSION_TERMINATED_PATTERNS: readonly RegExp[] = [
  /A session is either terminated or not started/i,
  /invalid session id/i,
  /NoSuchSessionError/
];

const WINDOW_CLOSED_PATTERNS: readonly RegExp[] = [
  /no such window/i,
  /target window already closed/i,
  /web view not found/i
];

/**
 * Builds the message thrown when the startup poll finds its session gone.
 *
 * @param params - What was being waited for, for how long, and the cause.
 * @returns The message.
 */
export function buildSessionTerminatedMessage(params: BuildSessionTerminatedMessageParams): string {
  const { deviceVaultPath, elapsedInMilliseconds, error, phase } = params;
  return `The Appium session ended while waiting for phase "${phase}" `
    + `(after ${String(elapsedInMilliseconds)}ms, vault ${deviceVaultPath}). `
    + 'Every later command would fail the same way, so the startup budget is not spent waiting on it. '
    + 'The Appium server log and logcat from that moment say why the session ended '
    + `(a crashed UiAutomator2 instrumentation is the usual cause). Cause: ${errorToString(error)}`;
}

/**
 * Classifies a failed WebView probe.
 *
 * Reads the error's `name` and `message` and those of its `cause` chain, since
 * WebdriverIO wraps the driver's answer.
 *
 * @param error - What the probe threw.
 * @returns The failure kind.
 */
export function classifyWebViewProbeFailure(error: unknown): WebViewProbeFailure {
  const text = collectErrorText(error);
  if (SESSION_TERMINATED_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'session-terminated';
  }
  return WINDOW_CLOSED_PATTERNS.some((pattern) => pattern.test(text)) ? 'window-closed' : 'other';
}

function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.name, current.message);
    current = current.cause;
  }
  if (typeof current === 'string') {
    parts.push(current);
  }
  return parts.join('\n');
}
