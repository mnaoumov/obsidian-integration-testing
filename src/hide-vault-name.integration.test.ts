import { createHash } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from 'vitest';

import { captureObsidianScreenshot } from './capture-obsidian-screenshot.ts';
import { readPngDimensions } from './capture-screenshot.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { hideVaultName } from './hide-vault-name.ts';
import { TemporaryVault } from './temporary-vault.ts';

// The desktop size the plugin store listings are shot at, so the frame these
// cases measure is the one a capture suite actually ships.
const WIDTH_IN_PIXELS = 1200;
const HEIGHT_IN_PIXELS = 800;

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const CAPTURE_TIMEOUT_IN_MILLISECONDS = 60_000;

// A string that is nothing like `temp-vault-<random>`, so a frame that still
// depended on the vault name could not accidentally match the one before it.
const REWRITTEN_VAULT_NAME = 'ZZZZ-a-completely-different-vault-name-ZZZZ';

const temporaryVault = new TemporaryVault();

beforeAll(async () => {
  await temporaryVault.register();
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

// Every case starts from a shown row: `hide()` persists, so a case that ran
// before would otherwise decide what the next one measures.
beforeEach(async () => {
  await showVaultName();
});

describe('hideVaultName integration', () => {
  it('hides every element rendering the vault name, and says how many', async () => {
    expect(await countShownVaultNameElements()).toBeGreaterThan(0);

    const hiddenCount = await hideVaultName({ vaultPath: temporaryVault.path });

    expect(hiddenCount).toBeGreaterThan(0);
    expect(await countShownVaultNameElements()).toBe(0);
  });

  it('is idempotent, because the text stays in place and a re-render puts the row back', async () => {
    const firstCount = await hideVaultName({ vaultPath: temporaryVault.path });
    const secondCount = await hideVaultName({ vaultPath: temporaryVault.path });

    // `hide()` sets `display: none` and leaves `textContent` alone, so the
    // second call finds exactly what the first one hid rather than nothing.
    expect(secondCount).toBe(firstCount);
    expect(await countShownVaultNameElements()).toBe(0);
  });

  it('is applied by a capture, without the caller asking for it', async () => {
    await captureObsidianScreenshot({
      heightInPixels: HEIGHT_IN_PIXELS,
      vaultPath: temporaryVault.path,
      widthInPixels: WIDTH_IN_PIXELS
    });

    expect(await countShownVaultNameElements()).toBe(0);
  }, CAPTURE_TIMEOUT_IN_MILLISECONDS);

  it('is skipped when the caller wants to photograph the vault switcher', async () => {
    await captureObsidianScreenshot({
      heightInPixels: HEIGHT_IN_PIXELS,
      shouldHideVaultName: false,
      vaultPath: temporaryVault.path,
      widthInPixels: WIDTH_IN_PIXELS
    });

    expect(await countShownVaultNameElements()).toBeGreaterThan(0);
  }, CAPTURE_TIMEOUT_IN_MILLISECONDS);

  it('makes the captured bytes independent of what the vault is called', async () => {
    const first = await capture();
    expect(readPngDimensions(first)).toStrictEqual({
      heightInPixels: HEIGHT_IN_PIXELS,
      widthInPixels: WIDTH_IN_PIXELS
    });

    // The control, and it comes first on purpose: two captures of an unchanged
    // window must already agree, or this case cannot tell the defect it is
    // about from a window that simply will not hold still.
    expect(sha256(await capture())).toBe(sha256(first));

    // The rows are hidden by now, so rewriting their text changes no pixel —
    // unless the frame still depends on the vault name, which is the whole
    // defect. Rewriting beats registering a second vault under a second name:
    // that would change the window's content as well, and prove nothing.
    expect(await rewriteHiddenVaultName()).toBeGreaterThan(0);

    expect(sha256(await capture())).toBe(sha256(first));
  }, CAPTURE_TIMEOUT_IN_MILLISECONDS);
});

/**
 * Captures the window at the store-listing size.
 *
 * @returns A {@link Promise} that resolves to the raw PNG bytes.
 */
async function capture(): Promise<Uint8Array> {
  return await captureObsidianScreenshot({
    heightInPixels: HEIGHT_IN_PIXELS,
    vaultPath: temporaryVault.path,
    widthInPixels: WIDTH_IN_PIXELS
  });
}

/**
 * Counts the elements rendering the vault's name that are actually on screen.
 *
 * `isShown()` walks the ancestors too, so an element hidden by a collapsed
 * parent counts as hidden here — which is what a capture sees.
 *
 * @returns A {@link Promise} that resolves to the number of shown elements.
 */
async function countShownVaultNameElements(): Promise<number> {
  return await evalInObsidian({
    callback({ app }): number {
      const vaultName = app.vault.getName();
      return [...document.querySelectorAll('*')]
        .filter((el): el is HTMLElement => el.instanceOf(HTMLElement) && el.childElementCount === 0 && el.textContent === vaultName)
        .filter((el) => el.isShown())
        .length;
    },
    vaultPath: temporaryVault.path
  });
}

/**
 * Replaces the text of every hidden element that still carries the vault's
 * name, leaving them hidden.
 *
 * @returns A {@link Promise} that resolves to the number of elements rewritten.
 */
async function rewriteHiddenVaultName(): Promise<number> {
  return await evalInObsidian({
    callback({ app, rewrittenVaultName }): number {
      const vaultName = app.vault.getName();
      const vaultNameEls = [...document.querySelectorAll('*')]
        .filter((el): el is HTMLElement => el.instanceOf(HTMLElement) && el.childElementCount === 0 && el.textContent === vaultName);

      for (const vaultNameEl of vaultNameEls) {
        vaultNameEl.textContent = rewrittenVaultName;
      }

      return vaultNameEls.length;
    },
    input: { rewrittenVaultName: REWRITTEN_VAULT_NAME },
    vaultPath: temporaryVault.path
  });
}

/**
 * Hashes a capture, so a mismatch reports two digests rather than two megabytes
 * of PNG.
 *
 * @param bytes - The PNG bytes.
 * @returns The hex-encoded SHA-256 digest.
 */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Un-hides every element rendering the vault's name, undoing whatever an
 * earlier case hid.
 */
async function showVaultName(): Promise<void> {
  await evalInObsidian({
    callback({ app }): void {
      const vaultName = app.vault.getName();
      const vaultNameEls = [...document.querySelectorAll('*')]
        .filter((el): el is HTMLElement => el.instanceOf(HTMLElement) && el.childElementCount === 0 && el.textContent === vaultName);

      for (const vaultNameEl of vaultNameEls) {
        vaultNameEl.show();
      }
    },
    vaultPath: temporaryVault.path
  });
}
