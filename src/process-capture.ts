/**
 * @file
 *
 * Attaches output capture and exit observation to a spawned child process.
 *
 * A long-running child spawned with piped stdio needs three things done to it,
 * and getting any of them wrong is its own bug: its pipes must be **drained**
 * (a full OS pipe buffer blocks the writer — a chatty renderer would hang the
 * app it belongs to), its output must be kept **bounded** (an hour of logs is
 * not a diagnostic), and its `exit` / `error` must be **recorded** so a caller
 * that later finds the process unreachable can say why instead of guessing.
 *
 * Extracted so the state machine is unit-testable: the launchers that use it
 * (`obsidian-instance.ts`, and the emulator/Appium spawns in
 * `transport-factory.ts`) are integration-time glue excluded from unit tests,
 * which is how the owned Obsidian instance came to be spawned `stdio: 'ignore'`
 * with no `exit` listener at all — its death was unobservable by construction.
 */

import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { ProcessExitInfo } from './process-exit-message.ts';

/**
 * Parameters for {@link attachProcessCapture}.
 */
export interface AttachProcessCaptureParams {
  /**
   * How many characters of the most recent output to keep. Older output is
   * dropped from the front as new output arrives.
   */
  readonly maxOutputLengthInCharacters: number;

  /**
   * Called for every chunk as it arrives, for callers that want the output
   * **live** (logged as the process runs) rather than only as a post-mortem
   * tail. Fires regardless of {@link ProcessCapture.stopCapture}, which freezes
   * the retained tail and nothing else.
   */
  readonly onChunk?: ((chunk: ProcessOutputChunk) => void) | undefined;
}

/**
 * A child process's captured output and exit status.
 */
export interface ProcessCapture {
  /**
  Returns the exit / spawn-failure details once the process is no longer running, otherwise `undefined`.
   */
  readExitInfo: () => ProcessExitInfo | undefined;

  /**
  Returns the captured stdout+stderr, bounded to the most recent output.
   */
  readOutput: () => string;

  /**
   * Stops accumulating output, freezing the tail at what has arrived so far.
   * Call once startup has succeeded and the tail has served its purpose.
   *
   * The `data` listeners stay attached deliberately, so the pipes keep draining
   * for the rest of the process's life.
   */
  stopCapture: () => void;
}

/**
 * One chunk of a child process's output, and which stream it came from.
 */
export interface ProcessOutputChunk {
  /**
  The stream the chunk was written to.
   */
  readonly stream: 'stderr' | 'stdout';

  /**
  The chunk's text.
   */
  readonly text: string;
}

/**
 * The `unref` a piped stdio stream carries through its underlying socket, which
 * `Readable` alone does not declare.
 */
interface StreamWithUnref {
  unref: () => void;
}

/**
 * Attaches output capture and exit observation to an already-spawned process.
 *
 * Tolerates a process spawned without pipes (`stdio: 'ignore'` leaves
 * `stdout` / `stderr` `null`): the exit half still works, and the captured
 * output stays empty.
 *
 * @param child - The spawned process.
 * @param params - The tail budget, and an optional live-output callback.
 * @returns Readers for the captured output and the exit status.
 */
export function attachProcessCapture(child: ChildProcess, params: AttachProcessCaptureParams): ProcessCapture {
  const { maxOutputLengthInCharacters, onChunk } = params;

  let capturedOutput = '';
  let exitInfo: ProcessExitInfo | undefined;
  let isCapturing = true;

  attachStream(child.stdout, 'stdout');
  attachStream(child.stderr, 'stderr');

  child.once('exit', (code: null | number, signal: NodeJS.Signals | null) => {
    exitInfo = { code, signal };
  });

  /*
   * A spawn failure (e.g. ENOENT for a missing binary) emits 'error', not
   * 'exit'. Record it as a synthetic exit so a caller polling for readiness can
   * fail fast instead of spinning out its whole budget against a process that
   * never existed.
   */
  child.once('error', (error: Error) => {
    exitInfo = { code: null, signal: null, spawnError: error.message };
  });

  return {
    readExitInfo: () => exitInfo,
    readOutput: () => capturedOutput,
    stopCapture: (): void => {
      isCapturing = false;
    }
  };

  function attachStream(stream: null | Readable, name: ProcessOutputChunk['stream']): void {
    if (!stream) {
      return;
    }

    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      onChunk?.({ stream: name, text });
      if (isCapturing) {
        capturedOutput = (capturedOutput + text).slice(-maxOutputLengthInCharacters);
      }
    });

    /*
     * `child.unref()` only releases the process handle; the stdio pipes are
     * separate handles that keep the event loop alive on their own. A harness
     * that pipes a detached child's output would then refuse to exit until that
     * child died — the opposite of what `detached` + `unref` was asked for.
     *
     * `unref` lives on the underlying socket rather than on `Readable`, so it is
     * reached structurally: a stream that does not carry one simply skips this.
     */
    (stream as Partial<StreamWithUnref>).unref?.();
  }
}
