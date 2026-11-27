/**
 * @file
 *
 * Refuses a capture while an element that must never be published is visible:
 * a notice naming a real path, a settings field holding a token, a personal
 * note's title.
 *
 * Screenshots are committed and published, so a frame that catches such an
 * element is a leak nobody reviews pixel by pixel. Re-implemented from the
 * `forbiddenSelectors` check of `obsidian-plugin-dev-kit`
 * (`src/e2e/demo/create-demo.ts`, `privacy.ts`, at aa82d95, MIT); no code was
 * copied. "Visible" is Chromium's own `checkVisibility` (display, visibility,
 * content-visibility and opacity), plus a box of non-zero size.
 *
 * `captureObsidianScreenshot` runs this when given `forbiddenSelectors`; it is
 * exported for a device capture, which has no page channel of its own.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type { EvalInObsidianParams } from '../eval/eval-in-obsidian.ts';
import type { ObsidianTransport } from '../transport/transport.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';
import { buildForbiddenElementMessage } from './capture-quality-options.ts';

/**
 * Parameters for {@link assertNoForbiddenElements}.
 */
export interface AssertNoForbiddenElementsParams {
  /**
   * What the check guards, for the error message.
   *
   * @default `'The capture'`
   */
  readonly action?: string;

  /**
   * CSS selectors no visible element may match.
   */
  readonly forbiddenSelectors: readonly string[];

  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to check. When omitted, the current test
   * context's vault is used.
   */
  readonly vaultPath?: string;
}

type ForbiddenInput = Record<'selectors', string[]>;

/**
 * Throws when a visible element matches one of the forbidden selectors.
 *
 * @param params - The selectors, and transport and vault overrides.
 * @returns A {@link Promise} that resolves when no forbidden element is visible.
 * @throws Error naming the first selector a visible element matched.
 */
export async function assertNoForbiddenElements(params: AssertNoForbiddenElementsParams): Promise<void> {
  const { action = 'The capture', forbiddenSelectors, transport, vaultPath } = params;
  const selectors = [...new Set(forbiddenSelectors)];
  if (selectors.length === 0) {
    return;
  }

  const matchedSelector = await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<ForbiddenInput, null | string>>({
    callback({ selectors: forbidden }): null | string {
      for (const selector of forbidden) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            continue;
          }
          if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
            return selector;
          }
        }
      }
      return null;
    },
    input: { selectors },
    transport,
    vaultPath
  }));

  if (matchedSelector !== null) {
    throw new Error(buildForbiddenElementMessage(matchedSelector, action));
  }
}

/* v8 ignore stop */
