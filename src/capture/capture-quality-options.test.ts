import {
  describe,
  expect,
  it
} from 'vitest';

import type { ScreenshotPresetName } from './capture-quality-options.ts';

import {
  buildForbiddenElementMessage,
  resolveFrozenTimestamp,
  resolveScreenshotGeometry,
  SCREENSHOT_PRESETS
} from './capture-quality-options.ts';

describe('SCREENSHOT_PRESETS', () => {
  it('should give each destination its exact PNG size and a density that divides it', () => {
    expect(SCREENSHOT_PRESETS).toStrictEqual({
      'listing-desktop': { deviceScaleFactor: 1, heightInPixels: 800, widthInPixels: 1200 },
      'listing-phone': { deviceScaleFactor: 2, heightInPixels: 1600, widthInPixels: 900 },
      'readme': { deviceScaleFactor: 1, heightInPixels: 640, widthInPixels: 1000 },
      'social': { deviceScaleFactor: 1, heightInPixels: 630, widthInPixels: 1200 }
    });
    for (const name of Object.keys(SCREENSHOT_PRESETS) as ScreenshotPresetName[]) {
      const preset = SCREENSHOT_PRESETS[name];
      expect(Number.isSafeInteger(preset.widthInPixels / preset.deviceScaleFactor)).toBe(true);
      expect(Number.isSafeInteger(preset.heightInPixels / preset.deviceScaleFactor)).toBe(true);
    }
  });
});

describe('resolveScreenshotGeometry', () => {
  it('should pass the size and density through when there is no preset', () => {
    expect(resolveScreenshotGeometry({ deviceScaleFactor: 2, heightInPixels: 800, widthInPixels: 1200 }, 'test')).toStrictEqual({
      deviceScaleFactor: 2,
      heightInPixels: 800,
      widthInPixels: 1200
    });
  });

  it('should leave the fields that were not given undefined, for the transport to default', () => {
    expect(resolveScreenshotGeometry({}, 'test')).toEqual({});
  });

  it('should expand a preset', () => {
    expect(resolveScreenshotGeometry({ preset: 'listing-phone' }, 'test')).toStrictEqual({
      deviceScaleFactor: 2,
      heightInPixels: 1600,
      widthInPixels: 900
    });
  });

  it('should refuse a preset combined with a size or a density', () => {
    expect(() => resolveScreenshotGeometry({ preset: 'readme', widthInPixels: 10 }, 'capture')).toThrow('capture: the preset "readme" fixes');
    expect(() => resolveScreenshotGeometry({ heightInPixels: 10, preset: 'readme' }, 'capture')).toThrow('cannot be combined');
    expect(() => resolveScreenshotGeometry({ deviceScaleFactor: 2, preset: 'readme' }, 'capture')).toThrow('cannot be combined');
  });

  it('should refuse an unknown preset, naming the known ones', () => {
    expect(() => resolveScreenshotGeometry({ preset: 'banner' as ScreenshotPresetName }, 'capture'))
      .toThrow('capture: unknown preset "banner". Known presets: listing-desktop, listing-phone, readme, social.');
  });
});

describe('buildForbiddenElementMessage', () => {
  it('should name the selector and what was refused', () => {
    expect(buildForbiddenElementMessage('.notice', 'captureObsidianScreenshot')).toBe(
      'captureObsidianScreenshot refused: an element matching the forbidden selector ".notice" is visible, so it would be in the picture. '
        + 'Close or hide it first, or drop the selector from forbiddenSelectors if it is allowed in this frame.'
    );
  });
});

describe('resolveFrozenTimestamp', () => {
  it('should accept a Date, an ISO string and a timestamp', () => {
    const timestamp = Date.UTC(2026, 2, 14, 9, 26);
    expect(resolveFrozenTimestamp(new Date(timestamp))).toBe(timestamp);
    expect(resolveFrozenTimestamp('2026-03-14T09:26:00Z')).toBe(timestamp);
    expect(resolveFrozenTimestamp(timestamp)).toBe(timestamp);
  });

  it('should refuse a value that is not a date', () => {
    expect(() => resolveFrozenTimestamp('soon')).toThrow('freezeObsidianTime: soon is not a date.');
  });
});
