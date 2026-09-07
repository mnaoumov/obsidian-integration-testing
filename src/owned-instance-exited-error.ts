/**
 * @file
 *
 * The distinct error thrown when the harness-owned Obsidian instance is gone —
 * it exited, and the CDP endpoint it was serving answers nothing.
 *
 * It exists to replace an anonymous cascade with one named cause. Before it,
 * every test file scheduled after a mid-run death failed in ~60–90 ms with
 * `TypeError: fetch failed` wrapping `connect ECONNREFUSED 127.0.0.1:<port>` —
 * measured at **156 such failures across 21 files** in `obsidian-patterns` on
 * 2026-09-05, not one of them a test result. The absence of an app is not a test
 * outcome, and this error says so in the words a reader needs: the instance
 * died, here is its exit code, and these failures are not about your code.
 *
 * Exported so callers can `instanceof`-match it, like `SilentAsarFallbackError`
 * and `RendererFailedToInitializeError`.
 */

import type { OwnedInstanceExitMarker } from './owned-instance-exit-marker.ts';

import { appendProcessOutputTail } from './process-exit-message.ts';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Parameters for the {@link OwnedInstanceExitedError} constructor.
 *
 * Everything but the URL is optional: the exit details come from the process
 * that launched the instance, and a caller in another process has them only
 * when the exit marker survived (see `owned-instance-exit-marker.ts`).
 */
export interface OwnedInstanceExitedErrorConstructorParams {
  /**
  The CDP URL the dead instance was serving.
   */
  readonly cdpUrl: string;

  /**
  Exit code, when known.
   */
  readonly code?: null | number | undefined;

  /**
  When the instance exited (`Date.now()` epoch milliseconds), when known.
   */
  readonly exitedAtInMilliseconds?: number | undefined;

  /**
  The tail of what the instance wrote to stdout/stderr, when any was captured.
   */
  readonly outputTail?: string | undefined;

  /**
  PID of the dead instance, when known.
   */
  readonly pid?: number | undefined;

  /**
  Terminating signal, when known.
   */
  readonly signal?: NodeJS.Signals | null | undefined;

  /**
  The spawn-failure message when the instance never started, otherwise absent.
   */
  readonly spawnError?: string | undefined;
}

/**
 * Thrown when the harness-owned Obsidian instance has exited and its CDP
 * endpoint is therefore unreachable. Carries whatever is known about the death
 * — exit code, signal, when it happened, and the output tail — so the failure
 * names its own cause instead of a refused connection.
 */
export class OwnedInstanceExitedError extends Error {
  /**
  The CDP URL the dead instance was serving.
   */
  public readonly cdpUrl: string;

  /**
  Exit code, when known.
   */
  public readonly code: null | number | undefined;

  /**
  When the instance exited (`Date.now()` epoch milliseconds), when known.
   */
  public readonly exitedAtInMilliseconds: number | undefined;

  /**
  Terminating signal, when known.
   */
  public readonly signal: NodeJS.Signals | null | undefined;

  /**
   * Creates the error from whatever is known about the instance's death.
   *
   * @param params - The CDP URL, and the exit details when they are available.
   */
  public constructor(params: OwnedInstanceExitedErrorConstructorParams) {
    super(buildMessage(params));
    this.name = 'OwnedInstanceExitedError';
    this.cdpUrl = params.cdpUrl;
    this.code = params.code;
    this.exitedAtInMilliseconds = params.exitedAtInMilliseconds;
    this.signal = params.signal;
  }
}

/**
 * Builds the error from an exit marker, for a process that did not launch the
 * instance and so has nothing else to go on.
 *
 * A missing marker is expected rather than exceptional — it is cleared on every
 * deliberate kill, and a hard enough kill records nothing — so the error is
 * still built, naming the instance without claiming to know how it died.
 *
 * @param cdpUrl - The CDP URL the dead instance was serving.
 * @param marker - The exit marker read for its port, or `undefined` when there is none.
 * @returns The error to throw in place of a refused connection.
 */
export function buildOwnedInstanceExitedErrorFromMarker(cdpUrl: string, marker: OwnedInstanceExitMarker | undefined): OwnedInstanceExitedError {
  if (!marker) {
    return new OwnedInstanceExitedError({ cdpUrl });
  }

  return new OwnedInstanceExitedError({
    cdpUrl,
    code: marker.code,
    exitedAtInMilliseconds: marker.exitedAtInMilliseconds,
    outputTail: marker.outputTail,
    pid: marker.pid,
    signal: marker.signal,
    spawnError: marker.spawnError
  });
}

function buildMessage(params: OwnedInstanceExitedErrorConstructorParams): string {
  const message = `The harness-owned Obsidian instance at ${params.cdpUrl} is gone: ${describeExit(params)}. `
    + 'Whatever ran after it had no app to talk to, so these failures are not test results — '
    + 'look for the `!!! OWNED OBSIDIAN EXITED` line in the run log for the moment it happened.';

  return appendProcessOutputTail(message, { output: params.outputTail ?? '', outputLabel: 'Obsidian output' });
}

function describeExit(params: OwnedInstanceExitedErrorConstructorParams): string {
  if (params.spawnError !== undefined) {
    return `it failed to start (${params.spawnError})`;
  }

  if (params.code === undefined && params.signal === undefined) {
    return 'it exited at some point during this run, and the harness recorded nothing about how '
      + '(the run that owns it logs the exit code; a worker sees only what the exit marker preserved)';
  }

  return `${describeProcess(params)} ${describeReason(params)}${describeWhen(params.exitedAtInMilliseconds)}`;
}

function describeProcess(params: OwnedInstanceExitedErrorConstructorParams): string {
  return params.pid === undefined ? 'it' : `its process (pid ${String(params.pid)})`;
}

function describeReason(params: OwnedInstanceExitedErrorConstructorParams): string {
  if (params.signal !== undefined && params.signal !== null) {
    return `was terminated by signal ${params.signal}`;
  }

  return params.code === undefined || params.code === null ? 'exited with no exit code' : `exited with code ${String(params.code)}`;
}

function describeWhen(exitedAtInMilliseconds: number | undefined): string {
  if (exitedAtInMilliseconds === undefined) {
    return '';
  }

  const elapsedInSeconds = Math.max(0, Math.round((Date.now() - exitedAtInMilliseconds) / MILLISECONDS_PER_SECOND));
  return ` ${String(elapsedInSeconds)}s ago, at ${new Date(exitedAtInMilliseconds).toISOString()}`;
}
