/**
 * @file
 *
 * The pure half of the failure artifacts: which artifacts a failed test leaves, where they go, what they are
 * called, and the bounded buffer the opt-in screencast keeps its frames in.
 *
 * A red integration test used to leave no picture of the window it failed against. The idea of keeping a picture
 * only for a failed test comes from `src/e2e/artifacts.ts` in [`obsidian-plugin-dev-kit`](https://github.com/Dimagious/obsidian-plugin-dev-kit) (aa82d95, MIT),
 * which keeps a Playwright trace and video of the Obsidian window. It is re-implemented here, not ported: no code
 * was copied, and the mechanism is CDP `Page.captureScreenshot` plus a `Page.startScreencast` frame buffer.
 */

import path from 'node:path';

/**
 * The environment variable that sets the screencast frame count for one run, over
 * {@link FailureArtifactsTransportOptions.failureScreencastFrameCount}. `0` turns the screencast off.
 */
export const FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME = 'OBSIDIAN_TEST_FAILURE_SCREENCAST_FRAMES';

/**
 * The environment variable that turns the failure screenshot off for one run (`0`, `false` or `off`), over
 * {@link FailureArtifactsTransportOptions.shouldCaptureFailureScreenshot}.
 */
export const FAILURE_SCREENSHOT_ENVIRONMENT_VARIABLE_NAME = 'OBSIDIAN_TEST_FAILURE_SCREENSHOT';

/**
 * Where failure artifacts go when no directory is configured, relative to the project root.
 */
export const DEFAULT_FAILURE_ARTIFACTS_DIRECTORY = path.join('dist', 'integration-test-failures');

/**
 * The longest artifact base name, so a long test name cannot push a path past the Windows limit.
 */
export const MAX_FAILURE_ARTIFACT_BASE_NAME_LENGTH = 120;

// Enough digits for MAX_FAILURE_SCREENCAST_FRAME_COUNT, so frame files sort by name.
const FRAME_NUMBER_DIGIT_COUNT = 4;

/**
 * The most frames a screencast buffer may be asked to keep. A frame is a JPEG of the window, tens of kilobytes,
 * so this bounds the buffer at tens of megabytes.
 */
export const MAX_FAILURE_SCREENCAST_FRAME_COUNT = 600;

/**
 * Parameters for {@link buildFailureArtifactBaseName}.
 */
export interface BuildFailureArtifactBaseNameParams {
  /**
   * The test file's path, or `null` when the framework does not say.
   */
  readonly filePath: null | string;

  /**
   * The test's full name, its describe blocks included.
   */
  readonly fullTestName: string;

  /**
   * The zero-based retry index of the failed attempt.
   */
  readonly retryCount: number;
}

/**
 * What a failed test leaves behind, resolved from the options and the environment.
 */
export interface FailureArtifactsSettings {
  /**
   * The absolute directory artifacts are written to.
   */
  readonly outputDirectory: string;

  /**
   * How many screencast frames are kept; `0` means no screencast.
   */
  readonly screencastFrameCount: number;

  /**
   * Whether a screenshot is written.
   */
  readonly shouldCaptureScreenshot: boolean;
}

/**
 * The failure-artifact fields of both transport option interfaces.
 */
export interface FailureArtifactsTransportOptions {
  /**
   * Where a failed test's artifacts are written, absolute or relative to the project root.
   *
   * @default `dist/integration-test-failures`
   */
  readonly failureArtifactsDirectory?: string;

  /**
   * How many of the most recent screencast frames to keep for a failed test. `0` keeps none and starts no
   * screencast.
   *
   * Opt-in, because a screencast makes the renderer encode a frame for every repaint of the whole test, whether it
   * fails or not. Desktop only; on Android it is skipped with a log line. For one run,
   * `OBSIDIAN_TEST_FAILURE_SCREENCAST_FRAMES=<n>` does the same and takes precedence.
   *
   * @default `0`
   */
  readonly failureScreencastFrameCount?: number;

  /**
   * Whether a failed test writes a screenshot of the Obsidian window it failed against.
   *
   * It costs nothing for a test that passes. For one run, `OBSIDIAN_TEST_FAILURE_SCREENSHOT=0` turns it off and
   * takes precedence.
   *
   * @default `true`
   */
  readonly shouldCaptureFailureScreenshot?: boolean;
}

/**
 * Parameters for {@link resolveFailureArtifactsSettings}.
 */
export interface ResolveFailureArtifactsSettingsParams {
  /**
   * The process environment.
   */
  readonly environment: Readonly<Record<string, string | undefined>>;

  /**
   * The transport options the worker resolved, or `null` when it has none.
   */
  readonly options: FailureArtifactsTransportOptions | null;

  /**
   * The project root a relative directory is resolved against.
   */
  readonly projectRoot: string;
}

/**
 * One frame of a screencast.
 */
export interface ScreencastFrame {
  /**
   * The frame's JPEG bytes.
   */
  readonly data: Uint8Array;

  /**
   * When the renderer painted the frame, in seconds since the epoch, or `null` when it did not say.
   */
  readonly timestampInSeconds: null | number;
}

/**
 * A bounded buffer that keeps the most recent screencast frames and drops the oldest.
 */
export class ScreencastFrameRing {
  /**
   * How many frames were pushed in all, the dropped ones included.
   *
   * @returns The total count.
   */
  public get totalFrameCount(): number {
    return this.pushedFrameCount;
  }

  private readonly capacity: number;
  private readonly frames: ScreencastFrame[] = [];
  private pushedFrameCount = 0;

  /**
   * Creates a buffer that keeps at most `capacity` frames.
   *
   * @param capacity - The most frames kept; at least 1.
   * @throws Error if the capacity is not a positive whole number.
   */
  public constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error(`ScreencastFrameRing: the capacity must be a positive whole number, got ${String(capacity)}.`);
    }
    this.capacity = capacity;
  }

  /**
   * Adds a frame, dropping the oldest one when the buffer is full.
   *
   * @param frame - The frame.
   */
  public push(frame: ScreencastFrame): void {
    this.pushedFrameCount++;
    this.frames.push(frame);
    if (this.frames.length > this.capacity) {
      this.frames.shift();
    }
  }

  /**
   * Returns the kept frames, oldest first.
   *
   * @returns A copy of the kept frames.
   */
  public snapshot(): readonly ScreencastFrame[] {
    return [...this.frames];
  }
}

/**
 * Builds the file-system-safe base name a failed test's artifacts share: the test file's name, the test's full
 * name, and the retry when it is not the first attempt.
 *
 * @param params - The file, the test name and the retry.
 * @returns A base name of at most {@link MAX_FAILURE_ARTIFACT_BASE_NAME_LENGTH} characters.
 */
export function buildFailureArtifactBaseName(params: BuildFailureArtifactBaseNameParams): string {
  const { filePath, fullTestName, retryCount } = params;
  const fileStem = filePath === null ? '' : path.basename(filePath).replace(/\.(?:[cm]?[jt]sx?)$/u, '');
  const retrySuffix = retryCount > 0 ? `--retry-${String(retryCount)}` : '';
  const stem = [fileStem, fullTestName].filter((part) => part !== '').join('--');
  const safeStem = sanitizeFileNamePart(stem);
  const room = MAX_FAILURE_ARTIFACT_BASE_NAME_LENGTH - retrySuffix.length;
  const trimmedStem = safeStem.slice(0, room).replace(/[-.]+$/u, '');
  return `${trimmedStem === '' ? 'test' : trimmedStem}${retrySuffix}`;
}

/**
 * Builds the file name of one kept frame.
 *
 * @param index - The zero-based index among the kept frames.
 * @returns `frame-0001.jpg` for index 0.
 */
export function buildScreencastFrameFileName(index: number): string {
  return `frame-${String(index + 1).padStart(FRAME_NUMBER_DIGIT_COUNT, '0')}.jpg`;
}

/**
 * Resolves what a failed test leaves behind. The environment wins over the options, so one run can change it
 * without editing a tracked file.
 *
 * @param params - The options, the environment and the project root.
 * @returns The resolved settings.
 * @throws Error if a frame count is not a whole number from 0 to {@link MAX_FAILURE_SCREENCAST_FRAME_COUNT}.
 */
export function resolveFailureArtifactsSettings(params: ResolveFailureArtifactsSettingsParams): FailureArtifactsSettings {
  const { environment, options, projectRoot } = params;

  const screenshotValue = environment[FAILURE_SCREENSHOT_ENVIRONMENT_VARIABLE_NAME]?.trim().toLowerCase();
  const shouldCaptureScreenshot = screenshotValue === undefined || screenshotValue === ''
    ? options?.shouldCaptureFailureScreenshot ?? true
    : !['0', 'false', 'no', 'off'].includes(screenshotValue);

  const framesValue = environment[FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME]?.trim();
  const screencastFrameCount = framesValue === undefined || framesValue === ''
    ? validateFrameCount(options?.failureScreencastFrameCount ?? 0, 'failureScreencastFrameCount')
    : validateFrameCount(Number(framesValue), FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME);

  return {
    outputDirectory: path.resolve(projectRoot, options?.failureArtifactsDirectory ?? DEFAULT_FAILURE_ARTIFACTS_DIRECTORY),
    screencastFrameCount,
    shouldCaptureScreenshot
  };
}

function sanitizeFileNamePart(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- Control characters are not allowed in Windows file names.
    .replaceAll(/[\u{0}-\u{1F}<>:"/\\|?*]+/gu, '-')
    .replaceAll(/\s+/gu, '-')
    .replaceAll(/-{3,}/gu, '--')
    .replace(/^[-.]+/u, '');
}

function validateFrameCount(value: number, source: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FAILURE_SCREENCAST_FRAME_COUNT) {
    throw new Error(
      `${source} must be a whole number from 0 to ${String(MAX_FAILURE_SCREENCAST_FRAME_COUNT)}, got ${String(value)}.`
    );
  }
  return value;
}
