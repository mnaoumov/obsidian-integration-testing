/**
 * @file
 *
 * The pure half of the capture-quality options: the named screenshot presets,
 * the size and density a capture resolves to, the forbidden-element message,
 * and the date `freezeObsidianTime` fixes.
 *
 * The presets and the idea of a forbidden selector come from
 * `obsidian-plugin-dev-kit` (`src/e2e/demo/presets.ts`, `privacy.ts`, at
 * aa82d95, MIT): re-implemented for this harness, no code copied. Kept apart
 * from the integration glue so every branch is unit-tested.
 */

import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';

/**
 * The picture a destination wants: its exact PNG size, and the device pixels per
 * CSS pixel it is shot at.
 */
export interface ScreenshotPreset {
  /**
   * Device pixels per CSS pixel. The page is laid out at the PNG size divided by
   * this.
   */
  readonly deviceScaleFactor: number;

  /**
   * The PNG height, in pixels.
   */
  readonly heightInPixels: number;

  /**
   * The PNG width, in pixels.
   */
  readonly widthInPixels: number;
}

/**
 * The destinations a screenshot can be shot for, each with exactly these
 * pixels:
 *
 * - `readme`: 1000 x 640, the widest a README picture is shown (GitHub scales
 *   anything wider down).
 * - `listing-desktop`: 1200 x 800, the community plugin listing, desktop.
 * - `listing-phone`: 900 x 1600, the listing, phone: a 450 x 800 layout at
 *   twice the density.
 * - `social`: 1200 x 630, a link preview card.
 */
/* eslint-disable no-magic-numbers -- The presets ARE these sizes; a constant per number would only restate it. */
export const SCREENSHOT_PRESETS = {
  'listing-desktop': { deviceScaleFactor: 1, heightInPixels: 800, widthInPixels: 1200 },
  'listing-phone': { deviceScaleFactor: 2, heightInPixels: 1600, widthInPixels: 900 },
  'readme': { deviceScaleFactor: 1, heightInPixels: 640, widthInPixels: 1000 },
  'social': { deviceScaleFactor: 1, heightInPixels: 630, widthInPixels: 1200 }
} as const satisfies Record<string, ScreenshotPreset>;
/* eslint-enable no-magic-numbers -- End of the presets table. */

/**
 * The size and density half of a capture's options.
 */
export interface ResolveScreenshotGeometryOptions {
  /**
   * Device pixels per CSS pixel.
   */
  readonly deviceScaleFactor?: number;

  /**
   * The exact PNG height, in pixels.
   */
  readonly heightInPixels?: number;

  /**
   * A named size and density, instead of the three options above.
   */
  readonly preset?: ScreenshotPresetName;

  /**
   * The exact PNG width, in pixels.
   */
  readonly widthInPixels?: number;
}

/**
 * What a capture's size options resolve to. A field left out stays for the
 * transport to default.
 */
export interface ScreenshotGeometry {
  /**
   * Device pixels per CSS pixel.
   */
  readonly deviceScaleFactor?: number;

  /**
   * The exact PNG height, in pixels.
   */
  readonly heightInPixels?: number;

  /**
   * The exact PNG width, in pixels.
   */
  readonly widthInPixels?: number;
}

/**
 * The name of a {@link SCREENSHOT_PRESETS} entry.
 */
export type ScreenshotPresetName = keyof typeof SCREENSHOT_PRESETS;

/**
 * Builds the message of a capture refused because a forbidden element is
 * visible.
 *
 * @param selector - The forbidden selector a visible element matched.
 * @param action - What was refused.
 * @returns The message.
 */
export function buildForbiddenElementMessage(selector: string, action: string): string {
  return `${action} refused: an element matching the forbidden selector ${JSON.stringify(selector)} is visible, so it would be in the picture. `
    + 'Close or hide it first, or drop the selector from forbiddenSelectors if it is allowed in this frame.';
}

/**
 * Resolves the moment `freezeObsidianTime` fixes the clock at.
 *
 * @param date - A `Date`, an ISO date-time string, or a timestamp in milliseconds.
 * @returns The timestamp in milliseconds.
 * @throws Error if the value is not a valid date.
 */
export function resolveFrozenTimestamp(date: Date | number | string): number {
  const timestamp = new Date(date).getTime();
  if (Number.isNaN(timestamp)) {
    throw new TypeError(`freezeObsidianTime: ${String(date)} is not a date. Pass a Date, an ISO string such as "2026-03-14T09:26:00", or a timestamp.`);
  }
  return timestamp;
}

/**
 * Resolves a capture's size options, expanding a preset.
 *
 * @param options - The size options.
 * @param action - What the caller is doing, for the error message.
 * @returns The size and density the transport should capture at.
 * @throws Error if the preset is unknown, or is combined with a size or a density, which it already fixes.
 */
export function resolveScreenshotGeometry(options: ResolveScreenshotGeometryOptions, action: string): ScreenshotGeometry {
  const { deviceScaleFactor, heightInPixels, preset, widthInPixels } = options;
  if (preset === undefined) {
    return normalizeOptionalProperties<ScreenshotGeometry>({
      deviceScaleFactor,
      heightInPixels,
      widthInPixels
    });
  }

  if (!Object.hasOwn(SCREENSHOT_PRESETS, preset)) {
    throw new Error(`${action}: unknown preset ${JSON.stringify(preset)}. Known presets: ${Object.keys(SCREENSHOT_PRESETS).join(', ')}.`);
  }

  if (deviceScaleFactor !== undefined || heightInPixels !== undefined || widthInPixels !== undefined) {
    throw new Error(
      `${action}: the preset ${JSON.stringify(preset)} fixes the size and the density, so it cannot be combined with widthInPixels, heightInPixels or deviceScaleFactor.`
    );
  }

  return { ...SCREENSHOT_PRESETS[preset] };
}
