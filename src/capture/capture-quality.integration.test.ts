import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { ScreenshotPresetName } from './capture-quality-options.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import { captureObsidianScreenshot } from './capture-obsidian-screenshot.ts';
import { SCREENSHOT_PRESETS } from './capture-quality-options.ts';
import { readPngDimensions } from './capture-screenshot.ts';
import { cleanObsidianUi } from './clean-obsidian-ui.ts';
import { freezeAnimations } from './freeze-animations.ts';
import { freezeObsidianTime } from './freeze-obsidian-time.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const CAPTURE_TIMEOUT_IN_MILLISECONDS = 120_000;

// A moment in the past, so a clock that was restored reads later than it.
const FROZEN_ISO = '2026-03-14T09:26:00Z';

const temporaryVault = new TemporaryVault();

beforeAll(async () => {
  await temporaryVault.register();
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

interface AnimationProbe {
  readonly endlessState: string;
  readonly finiteState: string;
  readonly transitionDuration: string;
}

interface ClockProbe {
  readonly constructedNow: number;
  readonly dateNow: number;
  readonly fromArguments: number;
  readonly functionCall: string;
  readonly isEarlierDateInstance: boolean;
  readonly isNewDateInstance: boolean;
  readonly momentNow: number;
}

interface UiProbe {
  readonly hasRibbonKey: boolean;
  readonly isLeftSplitCollapsed: boolean;
  readonly isStatusBarVisible: boolean;
  readonly isTabHeaderVisible: boolean;
  readonly showRibbon: unknown;
}

describe('capture quality integration', () => {
  it('shoots an unsized frame at twice the window size, and a sized one at exactly its size', async () => {
    const windowSize = await evalInObsidian({
      callback(): Record<'height' | 'width', number> {
        return { height: window.innerHeight, width: window.innerWidth };
      },
      vaultPath: temporaryVault.path
    });

    const unsized = readPngDimensions(await captureObsidianScreenshot({ vaultPath: temporaryVault.path }));
    expect(unsized).toStrictEqual({ heightInPixels: windowSize.height * 2, widthInPixels: windowSize.width * 2 });

    const atOne = readPngDimensions(await captureObsidianScreenshot({ deviceScaleFactor: 1, vaultPath: temporaryVault.path }));
    expect(atOne).toStrictEqual({ heightInPixels: windowSize.height, widthInPixels: windowSize.width });

    const sized = readPngDimensions(await captureObsidianScreenshot({ heightInPixels: 800, vaultPath: temporaryVault.path, widthInPixels: 1200 }));
    expect(sized).toStrictEqual({ heightInPixels: 800, widthInPixels: 1200 });

    // The override is cleared afterwards, density included.
    const ratio = await evalInObsidian({
      callback(): number {
        return window.devicePixelRatio;
      },
      vaultPath: temporaryVault.path
    });
    expect(ratio).toBe(1);
  }, CAPTURE_TIMEOUT_IN_MILLISECONDS);

  it('shoots each preset at its exact size, laid out at the size over the density', async () => {
    for (const name of Object.keys(SCREENSHOT_PRESETS) as ScreenshotPresetName[]) {
      const preset = SCREENSHOT_PRESETS[name];
      const png = await captureObsidianScreenshot({ preset: name, vaultPath: temporaryVault.path });
      expect(readPngDimensions(png)).toStrictEqual({ heightInPixels: preset.heightInPixels, widthInPixels: preset.widthInPixels });
    }

    await expect(captureObsidianScreenshot({ preset: 'readme', vaultPath: temporaryVault.path, widthInPixels: 10 }))
      .rejects.toThrow('cannot be combined');
  }, CAPTURE_TIMEOUT_IN_MILLISECONDS);

  it('finishes running animations, pauses endless ones and turns transitions off, then puts them back', async () => {
    await evalInObsidian({
      callback(): void {
        const el = document.body.createDiv({ cls: 'capture-quality-probe' });
        const endless = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 60_000, iterations: Infinity });
        const finite = el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(10px)' }], { duration: 60_000 });
        // A finished animation with no fill leaves `getAnimations()`, so the
        // probe reads both through references kept on the window.
        // eslint-disable-next-line no-restricted-syntax -- Approved double cast: probe values parked on the window for the next evaluation.
        (globalThis as unknown as Record<string, unknown>)['__captureQualityAnimations'] = { endless, finite };
      },
      vaultPath: temporaryVault.path
    });

    try {
      const frozen = await freezeAnimations({ vaultPath: temporaryVault.path });
      expect(frozen.pausedCount).toBeGreaterThanOrEqual(1);
      expect(frozen.finishedCount).toBeGreaterThanOrEqual(1);
      const during = await readAnimationProbe();
      expect(during).toStrictEqual({ endlessState: 'paused', finiteState: 'finished', transitionDuration: '0s' });

      await frozen.restore();
      const after = await readAnimationProbe();
      expect(after.endlessState).toBe('running');
      expect(after.transitionDuration).toBe('10s');
    } finally {
      await evalInObsidian({
        callback(): void {
          document.querySelector('.capture-quality-probe')?.remove();
        },
        vaultPath: temporaryVault.path
      });
    }
  });

  it('fixes Date and moment at one moment, keeps instanceof Date for earlier dates, and restores the clock', async () => {
    await evalInObsidian({
      callback(): void {
        // eslint-disable-next-line no-restricted-syntax -- Approved double cast: a probe value parked on the window for the next evaluation.
        (globalThis as unknown as Record<string, unknown>)['__captureQualityEarlierDate'] = new Date();
      },
      vaultPath: temporaryVault.path
    });

    const frozen = await freezeObsidianTime({ date: FROZEN_ISO, vaultPath: temporaryVault.path });
    const expected = Date.parse(FROZEN_ISO);
    expect(frozen.timestamp).toBe(expected);
    try {
      const probe = await readClockProbe();
      expect(probe).toStrictEqual({
        constructedNow: expected,
        dateNow: expected,
        fromArguments: Date.UTC(2020, 0, 1),
        functionCall: probe.functionCall,
        isEarlierDateInstance: true,
        isNewDateInstance: true,
        momentNow: expected
      });
      expect(probe.functionCall).toContain('2026');
    } finally {
      await frozen.restore();
    }

    const restored = await readClockProbe();
    expect(restored.dateNow).toBeGreaterThan(expected);
    expect(restored.momentNow).toBeGreaterThan(expected);
  });

  it('hides the chrome it is asked to, and puts every part back exactly', async () => {
    const before = await readUiProbe();
    expect(before.isStatusBarVisible).toBe(true);

    const cleaned = await cleanObsidianUi({ vaultPath: temporaryVault.path });
    const during = await readUiProbe();
    expect(during).toStrictEqual({
      hasRibbonKey: true,
      isLeftSplitCollapsed: true,
      isStatusBarVisible: false,
      isTabHeaderVisible: false,
      showRibbon: false
    });

    await cleaned.restore();
    const after = await readUiProbe();
    expect(after).toStrictEqual(before);
  });

  it('refuses a frame in which a forbidden element is visible, and takes one in which it is hidden', async () => {
    await evalInObsidian({
      callback(): void {
        const el = document.body.createDiv({ cls: 'capture-quality-secret', text: 'secret' });
        el.setCssStyles({ height: '20px', left: '0', position: 'fixed', top: '0', width: '20px', zIndex: '1000' });
      },
      vaultPath: temporaryVault.path
    });

    try {
      await expect(captureObsidianScreenshot({ forbiddenSelectors: ['.capture-quality-secret'], vaultPath: temporaryVault.path }))
        .rejects.toThrow('the forbidden selector ".capture-quality-secret" is visible');

      await evalInObsidian({
        callback(): void {
          document.querySelector<HTMLElement>('.capture-quality-secret')?.hide();
        },
        vaultPath: temporaryVault.path
      });
      const png = await captureObsidianScreenshot({ forbiddenSelectors: ['.capture-quality-secret'], vaultPath: temporaryVault.path });
      expect(png.length).toBeGreaterThan(0);
    } finally {
      await evalInObsidian({
        callback(): void {
          document.querySelector('.capture-quality-secret')?.remove();
        },
        vaultPath: temporaryVault.path
      });
    }
  }, CAPTURE_TIMEOUT_IN_MILLISECONDS);
});

/**
 * Reads the play state of the probe's two animations, and the transition a
 * fresh element with a declared transition computes.
 *
 * @returns A {@link Promise} that resolves to the {@link AnimationProbe}.
 */
async function readAnimationProbe(): Promise<AnimationProbe> {
  return await evalInObsidian({
    callback(): AnimationProbe {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: probe values parked on the window by the earlier evaluation.
      const { endless, finite } = (globalThis as unknown as Record<string, Record<'endless' | 'finite', Animation | undefined>>)['__captureQualityAnimations'] ?? {};
      const transitioned = document.body.createDiv();
      transitioned.setCssStyles({ transition: 'opacity 10s' });
      const transitionDuration = getComputedStyle(transitioned).transitionDuration;
      transitioned.remove();
      return {
        endlessState: endless?.playState ?? 'missing',
        finiteState: finite?.playState ?? 'missing',
        transitionDuration
      };
    },
    vaultPath: temporaryVault.path
  });
}

/**
 * Reads the window's clock through every route the freeze covers.
 *
 * @returns A {@link Promise} that resolves to the {@link ClockProbe}.
 */
async function readClockProbe(): Promise<ClockProbe> {
  return await evalInObsidian({
    callback(): ClockProbe {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: a probe value parked on the window by the earlier evaluation.
      const earlier = (globalThis as unknown as Record<string, unknown>)['__captureQualityEarlierDate'];
      return {
        constructedNow: Date.now(),
        dateNow: Date.now(),
        fromArguments: new Date(Date.UTC(2020, 0, 1)).getTime(),
        // eslint-disable-next-line unicorn/new-for-builtins -- The function form is one of the routes the freeze has to cover.
        functionCall: Date(),
        isEarlierDateInstance: earlier instanceof Date,
        isNewDateInstance: new Date() instanceof Date,
        momentNow: globalThis.moment().valueOf()
      };
    },
    vaultPath: temporaryVault.path
  });
}

/**
 * Reads the chrome parts {@link cleanObsidianUi} touches.
 *
 * @returns A {@link Promise} that resolves to the {@link UiProbe}.
 */
async function readUiProbe(): Promise<UiProbe> {
  return await evalInObsidian({
    callback({ app }): UiProbe {
      const statusBar = document.querySelector('.status-bar');
      const tabHeader = document.querySelector('.workspace-tab-header-container');
      return {
        hasRibbonKey: Object.hasOwn(app.vault.config, 'showRibbon'),
        isLeftSplitCollapsed: app.workspace.leftSplit.collapsed,
        isStatusBarVisible: statusBar?.checkVisibility() ?? false,
        isTabHeaderVisible: tabHeader?.checkVisibility() ?? false,
        showRibbon: app.vault.getConfig('showRibbon')
      };
    },
    vaultPath: temporaryVault.path
  });
}
