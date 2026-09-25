import type {
  AbstractInputSuggest,
  Modal
} from 'obsidian';

import { setTimeout as sleep } from 'node:timers/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { SharpRawResult } from './sharp-loader.ts';

import { captureObsidianScreenshot } from './capture-obsidian-screenshot.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { hideCaret } from './hide-caret.ts';
import { importSharp } from './sharp-loader.ts';
import { TemporaryVault } from './temporary-vault.ts';

// The desktop size the plugin store listings are shot at, so the frame these
// cases measure is the one a capture suite actually ships.
const WIDTH_IN_PIXELS = 1200;
const HEIGHT_IN_PIXELS = 800;

// Enough captures, spaced widely enough, to span more than one full blink
// (Chromium's caret blinks every ~500 ms): eight 170 ms apart cover ~1.4 s, so
// a caret still in the frame cannot land in the same phase every time.
const CAPTURE_COUNT = 8;
const CAPTURE_SPACING_IN_MILLISECONDS = 170;

// How many captures the settle wait takes at most before the series starts
// regardless; a window still changing after that fails the series, visibly.
const SETTLE_ATTEMPT_LIMIT = 10;

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const CAPTURE_SERIES_TIMEOUT_IN_MILLISECONDS = 120_000;

const NOTE_PATH = 'Caret.md';

const temporaryVault = new TemporaryVault();

beforeAll(async () => {
  await temporaryVault.register();
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

afterEach(async () => {
  await evalInObsidian({
    callback({ app }): void {
      // Closed through Obsidian rather than torn out of the DOM: a modal removed by
      // hand stays on Obsidian's own books, and the editor opened after it then
      // holds focus without ever blinking its caret, which hides the defect the
      // editor case exists to show.
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the probe modal is this suite's own Window property, kept local rather than declared globally.
      const holder = globalThis as unknown as ProbeModalHolder;
      holder.__hideCaretProbeSuggest?.close();
      holder.__hideCaretProbeModal?.close();
      holder.__hideCaretProbeSuggest = undefined;
      holder.__hideCaretProbeModal = undefined;
      app.workspace.detachLeavesOfType('markdown');
    },
    vaultPath: temporaryVault.path
  });
});

describe('hideCaret integration', () => {
  it('makes repeated captures of a focused input agree, where they alternate without it', async () => {
    await openModalInput();

    // The control: the defect is real on this window, or the assertion below
    // could pass for a caret that was never there.
    const shownChanges = await captureSeries({ shouldHideCaret: false });
    expect(Math.max(...shownChanges), shownChanges.join(' ')).toBeGreaterThan(0);
    const hiddenChanges = await captureSeries({ shouldHideCaret: true });
    expect(Math.max(...hiddenChanges), hiddenChanges.join(' ')).toBe(0);
  }, CAPTURE_SERIES_TIMEOUT_IN_MILLISECONDS);

  it('makes repeated captures of a focused Markdown editor agree, where they alternate without it', async () => {
    await openFocusedEditor();

    const shownChanges = await captureSeries({ shouldHideCaret: false });
    expect(Math.max(...shownChanges), shownChanges.join(' ')).toBeGreaterThan(0);
    const hiddenChanges = await captureSeries({ shouldHideCaret: true });
    expect(Math.max(...hiddenChanges), hiddenChanges.join(' ')).toBe(0);
  }, CAPTURE_SERIES_TIMEOUT_IN_MILLISECONDS);

  it('leaves the focus, and the suggester open because of it, as the test built them', async () => {
    await openModalInput();
    expect(await readInputState()).toStrictEqual({
      isFocused: true,
      openSuggesterCount: 1
    });

    await capture({ shouldHideCaret: true });

    // A blur would have closed the suggester: that is why the caret is made
    // transparent instead.
    expect(await readInputState()).toStrictEqual({
      isFocused: true,
      openSuggesterCount: 1
    });
  }, CAPTURE_SERIES_TIMEOUT_IN_MILLISECONDS);

  it('puts the focused element\'s own inline caret-color back after the capture', async () => {
    await openModalInput();
    await setInputCaretColor('rgb(255, 0, 0)');

    await capture({ shouldHideCaret: true });

    expect(await readInputCaretColor()).toBe('rgb(255, 0, 0)');
  }, CAPTURE_SERIES_TIMEOUT_IN_MILLISECONDS);

  it('removes the caret-color it set when the element had none of its own', async () => {
    await openModalInput();

    const hiddenCaret = await hideCaret({ vaultPath: temporaryVault.path });
    expect(hiddenCaret.isHidden).toBe(true);
    expect(await readInputCaretColor()).toBe('transparent');

    await hiddenCaret.restore();
    expect(await readInputCaretColor()).toBe('');
  });

  it('reports nothing hidden when nothing holds focus', async () => {
    await evalInObsidian({
      callback(): void {
        const activeEl = document.activeElement;
        if (activeEl?.instanceOf(HTMLElement)) {
          activeEl.blur();
        }
      },
      vaultPath: temporaryVault.path
    });

    const hiddenCaret = await hideCaret({ vaultPath: temporaryVault.path });
    expect(hiddenCaret.isHidden).toBe(false);
    await hiddenCaret.restore();
  });
});

interface CaptureOptions {
  readonly shouldHideCaret: boolean;
}

interface InputState {
  readonly isFocused: boolean;
  readonly openSuggesterCount: number;
}

interface ProbeModalHolder {
  __hideCaretProbeModal?: Modal | undefined;
  __hideCaretProbeSuggest?: AbstractInputSuggest<string> | undefined;
}

/**
 * Captures the window at the store-listing size.
 *
 * @param options - Whether to hide the caret.
 * @returns A {@link Promise} that resolves to the raw PNG bytes.
 */
async function capture(options: CaptureOptions): Promise<Uint8Array> {
  return await captureObsidianScreenshot({
    heightInPixels: HEIGHT_IN_PIXELS,
    shouldHideCaret: options.shouldHideCaret,
    vaultPath: temporaryVault.path,
    widthInPixels: WIDTH_IN_PIXELS
  });
}

/**
 * Captures one frame and decodes it to raw pixels.
 *
 * @param options - Whether to hide the caret.
 * @returns A {@link Promise} that resolves to the pixels and their geometry.
 */
async function captureRaw(options: CaptureOptions): Promise<SharpRawResult> {
  const sharp = await importSharp('hide-caret.integration.test');
  return await sharp(await capture(options)).raw().toBuffer({ resolveWithObject: true });
}

/**
 * Captures {@link CAPTURE_COUNT} frames, once the window has stopped changing
 * for reasons of its own, and reports how far each one strays from the first.
 *
 * The settle wait is not a caret workaround. A tab opened a moment ago draws
 * one more, different frame before it holds still (measured: the first of
 * eight caret-hidden captures of a fresh editor differed and the other seven
 * agreed), and that would read here exactly like a caret. So the series starts
 * only once two consecutive caret-hidden captures agree — which a blinking
 * caret cannot prevent, since it is hidden while they are taken.
 *
 * @param options - Whether to hide the caret.
 * @returns A {@link Promise} that resolves to, per frame in capture order, the
 *   number of pixels that changed against the first frame, so a failure shows
 *   WHICH frames differed and by how much.
 */
async function captureSeries(options: CaptureOptions): Promise<number[]> {
  let previous = await captureRaw({ shouldHideCaret: true });
  for (let attempt = 0; attempt < SETTLE_ATTEMPT_LIMIT; attempt++) {
    const current = await captureRaw({ shouldHideCaret: true });
    const changedPixelCount = countChangedPixels(previous, current);
    previous = current;
    if (changedPixelCount === 0) {
      break;
    }
  }

  const first = await captureRaw(options);
  const changedPixelCounts = [0];
  for (let index = 1; index < CAPTURE_COUNT; index++) {
    await sleep(CAPTURE_SPACING_IN_MILLISECONDS);
    const current = await captureRaw(options);
    changedPixelCounts.push(countChangedPixels(first, current));
  }
  return changedPixelCounts;
}

/**
 * Counts the pixels that differ at all between two frames of the same size.
 *
 * Exact, with no per-channel tolerance: the owned instance rasterizes on the
 * CPU (`deterministic-raster.ts`), so the soft shadows of the modal and the
 * suggester no longer come back one value off now and then, and a tolerance
 * here would only hide that channel reopening.
 *
 * @param first - One frame.
 * @param second - The other.
 * @returns The number of changed pixels.
 */
function countChangedPixels(first: SharpRawResult, second: SharpRawResult): number {
  const { channels } = first.info;
  let changedPixelCount = 0;
  for (let offset = 0; offset < first.data.length; offset += channels) {
    for (let channel = 0; channel < channels; channel++) {
      if (first.data[offset + channel] !== second.data[offset + channel]) {
        changedPixelCount++;
        break;
      }
    }
  }
  return changedPixelCount;
}

/**
 * Opens a note in a new tab and focuses its editor, with the cursor mid-line.
 */
async function openFocusedEditor(): Promise<void> {
  await evalInObsidian({
    async callback({ app, lib: { waitUntil }, notePath }): Promise<void> {
      const file = app.vault.getFileByPath(notePath) ?? await app.vault.create(notePath, '# Heading\n\nSome text here.\n');
      const leaf = app.workspace.getLeaf(true);
      await leaf.openFile(file);
      const editor = app.workspace.activeEditor?.editor;
      if (!editor) {
        throw new Error('No active editor after opening the note.');
      }
      editor.focus();
      editor.setCursor({ ch: 4, line: 2 });
      await waitUntil({
        message: 'the editor to take focus',
        predicate: () => {
          const activeEl = document.activeElement;
          return activeEl?.classList.contains('cm-content') ?? false;
        }
      });
    },
    input: { notePath: NOTE_PATH },
    vaultPath: temporaryVault.path
  });
}

/**
 * Opens a modal holding a focused text input with an `AbstractInputSuggest`
 * showing its suggestions under it.
 */
async function openModalInput(): Promise<void> {
  await evalInObsidian({
    async callback({ app, lib: { pressKey, waitUntil }, obsidianModule }): Promise<void> {
      class TestSuggest extends obsidianModule.AbstractInputSuggest<string> {
        public override renderSuggestion(value: string, el: HTMLElement): void {
          el.setText(value);
        }

        protected override getSuggestions(): string[] {
          return ['alpha', 'beta'];
        }
      }

      const modal = new obsidianModule.Modal(app);
      modal.open();
      const inputEl = modal.contentEl.createEl('input', { cls: 'hide-caret-probe', type: 'text' });
      const suggest = new TestSuggest(app, inputEl);
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the probe modal is this suite's own Window property, kept local rather than declared globally.
      const holder = globalThis as unknown as ProbeModalHolder;
      holder.__hideCaretProbeModal = modal;
      holder.__hideCaretProbeSuggest = suggest;
      inputEl.focus();
      await pressKey({ key: 'a' });
      await waitUntil({
        message: 'the suggester to open under the focused input',
        predicate: () => document.activeElement === inputEl && document.querySelectorAll('.suggestion-container').length === 1
      });
    },
    vaultPath: temporaryVault.path
  });
}

/**
 * Reads the probe input's own inline `caret-color`.
 *
 * @returns A {@link Promise} that resolves to the inline value, `''` when unset.
 */
async function readInputCaretColor(): Promise<string> {
  return await evalInObsidian({
    callback(): string {
      return document.querySelector<HTMLInputElement>('.hide-caret-probe')?.style.caretColor ?? 'missing';
    },
    vaultPath: temporaryVault.path
  });
}

/**
 * Reads whether the probe input still holds focus and how many suggesters are
 * open.
 *
 * @returns A {@link Promise} that resolves to the {@link InputState}.
 */
async function readInputState(): Promise<InputState> {
  return await evalInObsidian({
    callback(): InputState {
      return {
        isFocused: document.activeElement === document.querySelector('.hide-caret-probe'),
        openSuggesterCount: document.querySelectorAll('.suggestion-container').length
      };
    },
    vaultPath: temporaryVault.path
  });
}

/**
 * Gives the probe input an inline `caret-color` of its own.
 *
 * @param caretColor - The value to set.
 */
async function setInputCaretColor(caretColor: string): Promise<void> {
  await evalInObsidian({
    callback({ caretColor: value }): void {
      document.querySelector<HTMLInputElement>('.hide-caret-probe')?.setCssStyles({ caretColor: value });
    },
    input: { caretColor },
    vaultPath: temporaryVault.path
  });
}
