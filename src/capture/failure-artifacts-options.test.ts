import path from 'node:path';
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildFailureArtifactBaseName,
  buildScreencastFrameFileName,
  FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME,
  FAILURE_SCREENSHOT_ENVIRONMENT_VARIABLE_NAME,
  MAX_FAILURE_ARTIFACT_BASE_NAME_LENGTH,
  resolveFailureArtifactsSettings,
  ScreencastFrameRing
} from './failure-artifacts-options.ts';

const PROJECT_ROOT = path.resolve('project-root');

describe('resolveFailureArtifactsSettings', () => {
  it('defaults to a screenshot, no screencast and the dist directory', () => {
    expect(resolveFailureArtifactsSettings({ environment: {}, options: null, projectRoot: PROJECT_ROOT })).toEqual({
      outputDirectory: path.join(PROJECT_ROOT, 'dist', 'integration-test-failures'),
      screencastFrameCount: 0,
      shouldCaptureScreenshot: true
    });
  });

  it('reads the options', () => {
    expect(resolveFailureArtifactsSettings({
      environment: {},
      options: { failureArtifactsDirectory: 'out', failureScreencastFrameCount: 30, shouldCaptureFailureScreenshot: false },
      projectRoot: PROJECT_ROOT
    })).toEqual({
      outputDirectory: path.join(PROJECT_ROOT, 'out'),
      screencastFrameCount: 30,
      shouldCaptureScreenshot: false
    });
  });

  it('lets the environment win over the options', () => {
    const settings = resolveFailureArtifactsSettings({
      environment: {
        [FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME]: ' 12 ',
        [FAILURE_SCREENSHOT_ENVIRONMENT_VARIABLE_NAME]: 'OFF'
      },
      options: { failureScreencastFrameCount: 30, shouldCaptureFailureScreenshot: true },
      projectRoot: PROJECT_ROOT
    });
    expect(settings.screencastFrameCount).toBe(12);
    expect(settings.shouldCaptureScreenshot).toBe(false);
  });

  it('reads a screenshot value that is not an off word as on', () => {
    const settings = resolveFailureArtifactsSettings({
      environment: { [FAILURE_SCREENSHOT_ENVIRONMENT_VARIABLE_NAME]: '1' },
      options: { shouldCaptureFailureScreenshot: false },
      projectRoot: PROJECT_ROOT
    });
    expect(settings.shouldCaptureScreenshot).toBe(true);
  });

  it('ignores empty environment values', () => {
    const settings = resolveFailureArtifactsSettings({
      environment: { [FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME]: '', [FAILURE_SCREENSHOT_ENVIRONMENT_VARIABLE_NAME]: ' ' },
      options: { failureScreencastFrameCount: 5, shouldCaptureFailureScreenshot: false },
      projectRoot: PROJECT_ROOT
    });
    expect(settings.screencastFrameCount).toBe(5);
    expect(settings.shouldCaptureScreenshot).toBe(false);
  });

  it('keeps an absolute directory as it is', () => {
    const absolute = path.resolve('elsewhere');
    expect(
      resolveFailureArtifactsSettings({
        environment: {},
        options: { failureArtifactsDirectory: absolute },
        projectRoot: PROJECT_ROOT
      }).outputDirectory
    ).toBe(absolute);
  });

  it.each([
    ['abc', FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME],
    ['-1', FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME],
    ['1.5', FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME],
    ['601', FAILURE_SCREENCAST_FRAMES_ENVIRONMENT_VARIABLE_NAME]
  ])('refuses the environment frame count %s', (value, source) => {
    expect(() =>
      resolveFailureArtifactsSettings({
        environment: { [source]: value },
        options: null,
        projectRoot: PROJECT_ROOT
      })
    ).toThrow(`${source} must be a whole number from 0 to 600`);
  });

  it('refuses a bad option frame count, naming the option', () => {
    expect(() =>
      resolveFailureArtifactsSettings({
        environment: {},
        options: { failureScreencastFrameCount: -3 },
        projectRoot: PROJECT_ROOT
      })
    ).toThrow('failureScreencastFrameCount must be a whole number from 0 to 600, got -3.');
  });
});

describe('buildFailureArtifactBaseName', () => {
  it('joins the file stem and the full test name', () => {
    expect(buildFailureArtifactBaseName({
      filePath: path.join('src', 'a', 'thing.integration.test.ts'),
      fullTestName: 'thing > opens a modal',
      retryCount: 0
    })).toBe('thing.integration.test--thing--opens-a-modal');
  });

  it('replaces characters Windows refuses and collapses dash runs', () => {
    expect(buildFailureArtifactBaseName({
      filePath: null,
      fullTestName: 'a: b/c\\d*e?f"g<h>i|j\tk',
      retryCount: 0
    })).toBe('a--b-c-d-e-f-g-h-i-j-k');
  });

  it('adds the retry after the first attempt', () => {
    expect(buildFailureArtifactBaseName({ filePath: null, fullTestName: 'x', retryCount: 2 })).toBe('x--retry-2');
  });

  it('caps the length and keeps the retry suffix', () => {
    const name = buildFailureArtifactBaseName({ filePath: null, fullTestName: 'y'.repeat(500), retryCount: 1 });
    expect(name).toHaveLength(MAX_FAILURE_ARTIFACT_BASE_NAME_LENGTH);
    expect(name.endsWith('--retry-1')).toBe(true);
  });

  it('falls back to "test" for a name with nothing usable in it', () => {
    expect(buildFailureArtifactBaseName({ filePath: null, fullTestName: '...', retryCount: 0 })).toBe('test');
  });

  it('strips leading dots so the file is not hidden', () => {
    expect(buildFailureArtifactBaseName({ filePath: null, fullTestName: '.hidden', retryCount: 0 })).toBe('hidden');
  });
});

describe('ScreencastFrameRing', () => {
  it('keeps the most recent frames, oldest first, and counts every push', () => {
    const ring = new ScreencastFrameRing(2);
    for (const timestampInSeconds of [1, 2, 3]) {
      ring.push({ data: new Uint8Array([timestampInSeconds]), timestampInSeconds });
    }
    expect(ring.snapshot().map((frame) => frame.timestampInSeconds)).toEqual([2, 3]);
    expect(ring.totalFrameCount).toBe(3);
  });

  it('returns a copy', () => {
    const ring = new ScreencastFrameRing(1);
    const snapshot = ring.snapshot();
    ring.push({ data: new Uint8Array(), timestampInSeconds: null });
    expect(snapshot).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN])('refuses the capacity %s', (capacity) => {
    expect(() => new ScreencastFrameRing(capacity)).toThrow('must be a positive whole number');
  });
});

describe('buildScreencastFrameFileName', () => {
  it('numbers from 1 with four digits', () => {
    expect(buildScreencastFrameFileName(0)).toBe('frame-0001.jpg');
    expect(buildScreencastFrameFileName(41)).toBe('frame-0042.jpg');
  });
});
