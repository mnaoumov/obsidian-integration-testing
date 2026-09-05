/**
 * @file
 *
 * Pure builders for the diagnostic message describing an auto-started child
 * process (the Android emulator or the Appium server) that failed during
 * startup, appending the captured output tail when available.
 *
 * A startup fails two ways — the process **dies**, or it **hangs** past a
 * budget — and the captured tail is equally the explanation in both. So the
 * tail-appending half is its own export, used by the timeout throws that once
 * reported only the budget they blew.
 *
 * Kept separate from the integration-only `transport-factory` (excluded from
 * unit tests) so the message formatting stays unit-testable — the launchers
 * themselves spawn real processes.
 */

/**
 * Parameters for {@link appendProcessOutputTail}.
 */
export interface AppendProcessOutputTailParams {
  /**
  The captured stdout+stderr tail (empty when none was captured).
   */
  readonly output: string;

  /**
  Label for the captured output section (e.g. `"Emulator output"`).
   */
  readonly outputLabel: string;
}

/**
 * Parameters for {@link buildProcessExitMessage}.
 */
export interface BuildProcessExitMessageParams {
  /**
  The process's exit / spawn-failure details.
   */
  readonly exitInfo: ProcessExitInfo;

  /**
  The captured stdout+stderr tail (empty when none was captured).
   */
  readonly output: string;

  /**
  Label for the captured output section (e.g. `"Emulator output"`).
   */
  readonly outputLabel: string;

  /**
  Human-readable subject of the process (e.g. `"Android emulator"`).
   */
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
  /**
  Exit code, or `null` when terminated by a signal or when it failed to spawn.
   */
  readonly code: null | number;

  /**
  Terminating signal, or `null` when it exited normally or failed to spawn.
   */
  readonly signal: NodeJS.Signals | null;

  /**
  The spawn-failure message when the process never started (e.g. `ENOENT`), otherwise absent.
   */
  readonly spawnError?: string;
}

/**
 * Appends a process's captured output tail to a message, when there is one.
 *
 * Split out of {@link buildProcessExitMessage} so the **timeout** failures can
 * carry the tail too. A process that dies gets its output attached; one that
 * hangs used to get `No new emulator device appeared within 300000ms.` and
 * nothing else — even though the line that explains it (`FATAL | Running
 * multiple emulators with the same AVD is an experimental feature`) had already
 * been captured. The emulator writing its own diagnosis is worth nothing if the
 * harness reads it on only one of the two ways a startup can fail.
 *
 * @param message - The failure message to extend.
 * @param params - The captured tail and its label.
 * @returns The message, with the tail appended when non-empty.
 */
export function appendProcessOutputTail(message: string, params: AppendProcessOutputTailParams): string {
  const trimmedOutput = params.output.trim();
  if (trimmedOutput.length === 0) {
    return message;
  }

  return `${message}\n\n${params.outputLabel} (tail):\n${trimmedOutput}`;
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

  return appendProcessOutputTail(`${subject} ${resolveReason(exitInfo)} during startup.`, { output, outputLabel });
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
