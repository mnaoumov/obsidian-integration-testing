/**
 * @file
 *
 * Hides the text caret of the focused element for the length of a capture, so
 * a frame does not depend on which phase of its blink the capture landed in.
 *
 * A focused `<input>` or a focused editor blinks its caret about twice a second,
 * and a capture photographs whichever phase it happens to catch. Two captures
 * of an unchanged window therefore alternate between two byte streams: measured
 * against Obsidian 1.14 at the 1200x800 store size, eight captures 170 ms apart
 * gave 2 distinct PNGs for a focused modal input and 2 for a focused Markdown
 * editor, and exactly 1 each once the caret was transparent.
 *
 * **`caret-color: transparent`, not `blur()`**, and the difference is not
 * cosmetic. Blurring does make the bytes stable too, but it is a state change
 * the app observes: in the same run an open `AbstractInputSuggest` popover closed
 * the moment its input lost focus, so a blur would photograph a different frame
 * from the one the test built. It also drops the focus ring, which does not
 * blink and is often part of what the frame is showing. Obsidian draws its
 * editor caret natively (the CodeMirror cursor layer is empty), so one
 * `caret-color` covers inputs and the editor alike.
 *
 * **Restored afterwards**, unlike the vault name `hideVaultName` hides: the
 * focused field is live state a test goes on typing into, and a caret that
 * silently stayed invisible would be a surprise with no error attached.
 *
 * `captureObsidianScreenshot` calls this by default. It is exported for the
 * captures that cannot: `captureDeviceScreenshot` reads the device framebuffer
 * over `adb` and has no page channel, and its typical frame — a field with the
 * soft keyboard under it — is exactly the frame where blurring is wrong, since
 * blurring would take the keyboard down with the focus.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type { EvalInObsidianParams } from './eval-in-obsidian.ts';
import type { ObsidianTransport } from './transport.ts';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { normalizeOptionalProperties } from './normalize-optional-properties.ts';

/**
 * What {@link hideCaret} returns: whether a caret was hidden, and how to put it
 * back.
 */
export interface HiddenCaret {
  /**
   * Whether an element held focus, and so had a caret to hide. `false` is a
   * legitimate answer — a frame with nothing focused has no caret — and
   * {@link restore} is then a no-op.
   */
  readonly isHidden: boolean;

  /**
   * Puts the focused element's own inline `caret-color` back, exactly as it
   * was — removed when it had none.
   *
   * @returns A {@link Promise} that resolves once the caret is restored.
   */
  restore: () => Promise<void>;
}

/**
 * Options for {@link hideCaret}.
 */
export interface HideCaretOptions {
  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to hide the caret in. When omitted, the
   * current test context's vault is used.
   */
  readonly vaultPath?: string;
}

// A `window` property rather than a closure variable: the hide and the restore
// are two separate evaluations, and the element is not serializable. The key is
// spelled out in the holder rather than shared through a constant, because a
// closure is serialized and cannot reach module scope.
//
// Kept local rather than declared globally, like every other holder of a
// harness `window` property, so it never leaks into consumer types.
interface HiddenCaretHolder {
  __obsidianIntegrationTestingHiddenCaret?: HiddenCaretRecord | undefined;
}

interface HiddenCaretRecord {
  readonly el: HTMLElement;
  readonly previousCaretColor: string;
}

/**
 * Makes the caret of the focused element transparent, leaving the focus itself
 * alone.
 *
 * The element is found through nested shadow roots, since
 * `document.activeElement` stops at a shadow host and the caret belongs to the
 * element inside it. Re-applying before a restore keeps the ORIGINAL value, so
 * two hides and one restore still leave the element as it was found; a hide on
 * a different element first restores the one an unrestored hide left behind.
 *
 * @param options - Transport and vault overrides.
 * @returns A {@link Promise} that resolves to the {@link HiddenCaret}.
 */
export async function hideCaret(options?: HideCaretOptions): Promise<HiddenCaret> {
  const { transport, vaultPath } = options ?? {};

  const isHidden = await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, boolean>>({
    callback(): boolean {
      let activeEl = document.activeElement;
      while (activeEl?.shadowRoot?.activeElement) {
        activeEl = activeEl.shadowRoot.activeElement;
      }

      if (!activeEl?.instanceOf(HTMLElement) || activeEl === document.body) {
        return false;
      }

      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the hidden-caret record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as HiddenCaretHolder;
      const existing = holder.__obsidianIntegrationTestingHiddenCaret;
      if (existing?.el !== activeEl) {
        // A hide that was never restored, on an element that has since lost
        // focus: put that one back rather than orphan it invisible.
        existing?.el.setCssStyles({ caretColor: existing.previousCaretColor });
        holder.__obsidianIntegrationTestingHiddenCaret = {
          el: activeEl,
          previousCaretColor: activeEl.style.caretColor
        };
      }

      activeEl.setCssStyles({ caretColor: 'transparent' });
      return true;
    },
    transport,
    vaultPath
  }));

  return {
    isHidden,
    async restore(): Promise<void> {
      if (!isHidden) {
        return;
      }

      await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, void>>({
        callback(): void {
          // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the hidden-caret record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
          const holder = globalThis as unknown as HiddenCaretHolder;
          const record = holder.__obsidianIntegrationTestingHiddenCaret;
          if (!record) {
            return;
          }

          record.el.setCssStyles({ caretColor: record.previousCaretColor });
          holder.__obsidianIntegrationTestingHiddenCaret = undefined;
        },
        transport,
        vaultPath
      }));
    }
  };
}

/* v8 ignore stop */
