/**
 * @file
 *
 * Pure builder for the diagnostic message describing an auto-started child
 * process (the Android emulator or the Appium server) that died during startup,
 * appending the captured output tail when available.
 *
 * Kept separate from the integration-only `transport-factory` (excluded from
 * unit tests) so the message formatting stays unit-testable — the launchers
 * themselves spawn real processes.
 */

/**
 * Parameters for {@link buildProcessExitMessage}.
 */
export interface BuildProcessExitMessageParams {
  /** The process's exit / spawn-failure details. */
  readonly exitInfo: ProcessExitInfo;

  /** The captured stdout+stderr tail (empty when none was captured). */
  readonly output: string;

  /** Label for the captured output section (e.g. `"Emulator output"`). */
  readonly outputLabel: string;

  /** Human-readable subject of the process (e.g. `"Android emulator"`). */
  readonly subject: string;
}

/**
 * Details of a spawned child process that has exited or failed to spawn.
 *
 * A normal exit sets `code`/`signal` (exactly one is non-`null`); a spawn
 * failure (e.g. `ENOENT` for a missing binary) leaves both `null` and sets
 * `spawnError` to the failure message.
 */
export interface ProcessExitInfo {
  /** Exit code, or `null` when terminated by a signal or when it failed to spawn. */
  readonly code: null | number;

  /** Terminating signal, or `null` when it exited normally or failed to spawn. */
  readonly signal: NodeJS.Signals | null;

  /** The spawn-failure message when the process never started (e.g. `ENOENT`), otherwise absent. */
  readonly spawnError?: string;
}

/**
 * Builds a descriptive error message for an auto-started child process that
 * exited (or failed to spawn) during startup, appending the captured output
 * tail when available.
 *
 * @param params - The subject, exit details, and captured output.
 * @returns A human-readable error message.
 */
export function buildProcessExitMessage(params: BuildProcessExitMessageParams): string {
  const { exitInfo, output, outputLabel, subject } = params;

  const reason = resolveReason(exitInfo);
  const trimmedOutput = output.trim();
  const details = trimmedOutput.length > 0
    ? `\n\n${outputLabel} (tail):\n${trimmedOutput}`
    : '';
  return `${subject} ${reason} during startup.${details}`;
}

/**
 * Describes why the process is no longer running.
 *
 * @param exitInfo - The exit / spawn-failure details.
 * @returns The reason clause.
 */
function resolveReason(exitInfo: ProcessExitInfo): string {
  if (exitInfo.spawnError !== undefined) {
    return `failed to start (${exitInfo.spawnError})`;
  }
  if (exitInfo.signal !== null) {
    return `was terminated by signal ${exitInfo.signal}`;
  }
  return `exited prematurely with code ${exitInfo.code === null ? '(null)' : String(exitInfo.code)}`;
}
