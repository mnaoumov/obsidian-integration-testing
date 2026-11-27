/**
 * @file
 *
 * Writes what a failed test leaves behind: a screenshot of the Obsidian window it failed against and, when a
 * screencast was recording, its most recent frames.
 *
 * The framework-agnostic half. The Vitest per-worker setup wires it to every test (`vitest/failure-artifacts.ts`);
 * a Jest or hand-wired suite calls {@link writeFailureArtifacts} from its own failure handler. The idea comes from
 * `src/e2e/artifacts.ts` in [`obsidian-plugin-dev-kit`](https://github.com/Dimagious/obsidian-plugin-dev-kit) (aa82d95, MIT); see `failure-artifacts-options.ts`.
 *
 * Everything here is best-effort: a test that failed because the instance died must still report its own
 * failure, so a step that throws or stalls is logged and skipped, and never replaces the test's error.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian and the file system) covered by integration tests, not unit tests. */

import {
  mkdir,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';

import type {
  ObsidianTransport,
  ScreencastRecording
} from '../transport/transport.ts';

import { errorToString } from '../error-to-string.ts';
import { log } from '../log.ts';
import { buildScreencastFrameFileName } from './failure-artifacts-options.ts';

/**
 * How long one artifact step may take before it is given up on. A dead instance would otherwise hold a failure
 * hook for the whole CDP command timeout.
 */
export const FAILURE_ARTIFACT_STEP_TIMEOUT_IN_MILLISECONDS = 20_000;

const JSON_INDENT = 2;

/**
 * What {@link writeFailureArtifacts} wrote, and what it could not.
 */
export interface FailureArtifactsResult {
  /**
   * How many frames were written.
   */
  readonly frameCount: number;

  /**
   * The directory the frames went to, or `null` when none were written.
   */
  readonly framesDirectory: null | string;

  /**
   * One line per step that failed.
   */
  readonly problems: readonly string[];

  /**
   * The screenshot's path, or `null` when none was written.
   */
  readonly screenshotPath: null | string;
}

/**
 * Parameters for {@link startFailureScreencast}.
 */
export interface StartFailureScreencastParams {
  /**
   * How many of the most recent frames to keep.
   */
  readonly frameCount: number;

  /**
   * The transport driving the window.
   */
  readonly transport: ObsidianTransport;

  /**
   * The vault whose window to record.
   */
  readonly vaultPath: string;
}

/**
 * Parameters for {@link writeFailureArtifacts}.
 */
export interface WriteFailureArtifactsParams {
  /**
   * The file-system-safe base name the artifacts share, from `buildFailureArtifactBaseName`.
   */
  readonly baseName: string;

  /**
   * The directory to write into; created when missing.
   */
  readonly outputDirectory: string;

  /**
   * A running screencast whose kept frames to write, or `null` for none.
   */
  readonly screencast: null | ScreencastRecording;

  /**
   * Whether to write a screenshot.
   */
  readonly shouldCaptureScreenshot: boolean;

  /**
   * The transport driving the window.
   */
  readonly transport: ObsidianTransport;

  /**
   * The vault whose window to capture.
   */
  readonly vaultPath: string;
}

/**
 * Formats a result as one log line.
 *
 * @param result - What was written.
 * @param testName - The failed test's name.
 * @returns The line.
 */
export function describeFailureArtifacts(result: FailureArtifactsResult, testName: string): string {
  const written = [
    result.screenshotPath === null ? null : `screenshot ${result.screenshotPath}`,
    result.framesDirectory === null ? null : `${String(result.frameCount)} screencast frame(s) in ${result.framesDirectory}`
  ].filter((part) => part !== null);
  const problems = result.problems.length > 0 ? ` Not written: ${result.problems.join('; ')}.` : '';
  return `[failure-artifacts] "${testName}" failed: ${written.length > 0 ? `wrote ${written.join(' and ')}.` : 'wrote nothing.'}${problems}`;
}

/**
 * Starts the screencast a failed test's frames come from. Never throws.
 *
 * @param params - Which window, and how many frames to keep.
 * @returns The running recording, or `null` when the transport has no screencast or it would not start.
 */
export async function startFailureScreencast(params: StartFailureScreencastParams): Promise<null | ScreencastRecording> {
  const { frameCount, transport, vaultPath } = params;
  if (!transport.startScreencast) {
    log('[failure-artifacts] The transport has no screencast, so failed tests get a screenshot only.');
    return null;
  }
  try {
    return await withTimeout(transport.startScreencast({ cwd: vaultPath, frameCount }), 'starting the screencast');
  } catch (error: unknown) {
    log(`[failure-artifacts] Could not start the failure screencast (non-fatal): ${errorToString(error)}`);
    return null;
  }
}

/**
 * Writes a failed test's screenshot and kept screencast frames. Never throws.
 *
 * The frames go to `<baseName>-frames/` as numbered JPEGs, with a `frames.json` that gives each frame's paint time.
 *
 * @param params - What to write, and where.
 * @returns What was written, and one line per step that failed.
 */
export async function writeFailureArtifacts(params: WriteFailureArtifactsParams): Promise<FailureArtifactsResult> {
  const { baseName, outputDirectory, screencast, shouldCaptureScreenshot, transport, vaultPath } = params;
  const problems: string[] = [];
  let screenshotPath: null | string = null;
  let framesDirectory: null | string = null;
  let frameCount = 0;

  try {
    await mkdir(outputDirectory, { recursive: true });
  } catch (error: unknown) {
    return {
      frameCount,
      framesDirectory,
      problems: [`could not create ${outputDirectory}: ${errorToString(error)}`],
      screenshotPath
    };
  }

  if (shouldCaptureScreenshot) {
    if (transport.captureScreenshot) {
      try {
        const png = await withTimeout(transport.captureScreenshot({ cwd: vaultPath }), 'the screenshot');
        screenshotPath = path.join(outputDirectory, `${baseName}.png`);
        await writeFile(screenshotPath, png);
      } catch (error: unknown) {
        screenshotPath = null;
        problems.push(`screenshot: ${errorToString(error)}`);
      }
    } else {
      problems.push('screenshot: the transport cannot capture screenshots');
    }
  }

  if (screencast) {
    const frames = screencast.snapshot();
    if (frames.length > 0) {
      try {
        framesDirectory = path.join(outputDirectory, `${baseName}-frames`);
        await mkdir(framesDirectory, { recursive: true });
        const index = [];
        for (const [frameIndex, frame] of frames.entries()) {
          const fileName = buildScreencastFrameFileName(frameIndex);
          await writeFile(path.join(framesDirectory, fileName), frame.data);
          index.push({ file: fileName, timestampInSeconds: frame.timestampInSeconds });
          frameCount++;
        }
        await writeFile(
          path.join(framesDirectory, 'frames.json'),
          `${JSON.stringify({ framesKept: frames.length, framesSent: screencast.totalFrameCount(), index }, null, JSON_INDENT)}\n`
        );
      } catch (error: unknown) {
        problems.push(`screencast frames: ${errorToString(error)}`);
      }
    } else {
      problems.push('screencast frames: the renderer painted none while the test ran');
    }
  }

  return { frameCount, framesDirectory, problems, screenshotPath };
}

async function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not finish within ${String(FAILURE_ARTIFACT_STEP_TIMEOUT_IN_MILLISECONDS)}ms`));
    }, FAILURE_ARTIFACT_STEP_TIMEOUT_IN_MILLISECONDS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* v8 ignore stop */
