import {
  mkdtemp,
  readdir,
  readFile,
  rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianTransport } from '../transport/transport.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { getMostRecentRegisteredVault } from '../vault/registered-vaults.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import { isPng } from './capture-screenshot.ts';
import {
  startFailureScreencast,
  writeFailureArtifacts
} from './failure-artifacts.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 60_000;
const KEPT_FRAME_COUNT = 3;
const CHURN_DURATION_IN_MILLISECONDS = 1500;

interface FramesIndex {
  readonly framesKept: number;
  readonly index: readonly FramesIndexEntry[];
}

interface FramesIndexEntry {
  readonly file: string;
}

const temporaryVault = new TemporaryVault();
let outputDirectory = '';

beforeAll(async () => {
  await temporaryVault.register();
  outputDirectory = await mkdtemp(path.join(tmpdir(), 'oit-failure-artifacts-'));
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
  await rm(outputDirectory, { force: true, recursive: true });
});

function checkIsJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
}

async function churnThePage(): Promise<void> {
  await evalInObsidian({
    callback: async ({ durationInMilliseconds }) => {
      const element = document.body.createDiv({ cls: 'oit-failure-artifacts-churn' });
      const startedAt = Date.now();
      while (Date.now() - startedAt < durationInMilliseconds) {
        element.setText(String(Date.now()));
        await new Promise((resolve) => {
          setTimeout(resolve, 30);
        });
      }
      element.remove();
    },
    input: { durationInMilliseconds: CHURN_DURATION_IN_MILLISECONDS },
    vaultPath: temporaryVault.path
  });
}

function getTransport(): ObsidianTransport {
  const registered = getMostRecentRegisteredVault();
  if (registered?.path !== temporaryVault.path) {
    throw new Error('The suite vault is not the most recently registered one.');
  }
  return registered.transport;
}

describe('failure artifacts integration', () => {
  it('keeps only the most recent screencast frames, each a JPEG', async () => {
    const transport = getTransport();
    const recording = await startFailureScreencast({ frameCount: KEPT_FRAME_COUNT, transport, vaultPath: temporaryVault.path });
    expect(recording).not.toBeNull();
    await churnThePage();
    const frames = await recording?.stop() ?? [];

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(KEPT_FRAME_COUNT);
    expect(recording?.totalFrameCount()).toBeGreaterThan(KEPT_FRAME_COUNT);
    for (const frame of frames) {
      expect(checkIsJpeg(frame.data)).toBe(true);
    }

    // Stopping twice is safe, and a stopped recording sends nothing more.
    const countAfterStop = recording?.totalFrameCount();
    await churnThePage();
    await recording?.stop();
    expect(recording?.totalFrameCount()).toBe(countAfterStop);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('writes the screenshot and the kept frames with their index', async () => {
    const transport = getTransport();
    const recording = await startFailureScreencast({ frameCount: KEPT_FRAME_COUNT, transport, vaultPath: temporaryVault.path });
    try {
      await churnThePage();
      const result = await writeFailureArtifacts({
        baseName: 'writes-both',
        outputDirectory,
        screencast: recording,
        shouldCaptureScreenshot: true,
        transport,
        vaultPath: temporaryVault.path
      });

      expect(result.problems).toEqual([]);
      expect(result.screenshotPath).toBe(path.join(outputDirectory, 'writes-both.png'));
      const screenshot = await readFile(result.screenshotPath ?? '');
      expect(isPng(new Uint8Array(screenshot))).toBe(true);

      expect(result.framesDirectory).toBe(path.join(outputDirectory, 'writes-both-frames'));
      const files = await readdir(result.framesDirectory ?? '');
      expect(files).toContain('frames.json');
      expect(files.filter((file) => file.endsWith('.jpg'))).toHaveLength(result.frameCount);
      const indexText = await readFile(path.join(result.framesDirectory ?? '', 'frames.json'), 'utf-8');
      const index = JSON.parse(indexText) as FramesIndex;
      expect(index.framesKept).toBe(result.frameCount);
      expect(index.index[0]?.file).toBe('frame-0001.jpg');
    } finally {
      await recording?.stop();
    }
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('reports a transport that cannot capture instead of throwing', async () => {
    // Only `captureScreenshot` is read, so a transport without it is all this case needs.
    const withoutCapture = { isMobile: false } as ObsidianTransport;
    const result = await writeFailureArtifacts({
      baseName: 'no-capture',
      outputDirectory,
      screencast: null,
      shouldCaptureScreenshot: true,
      transport: withoutCapture,
      vaultPath: temporaryVault.path
    });
    expect(result.screenshotPath).toBeNull();
    expect(result.problems).toEqual(['screenshot: the transport cannot capture screenshots']);
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
