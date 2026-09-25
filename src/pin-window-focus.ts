/**
 * @file
 *
 * Draws the Obsidian window as FOCUSED for the length of a capture, so a frame
 * does not depend on whether the operating system gave the window foreground
 * focus that run.
 *
 * Obsidian styles its window chrome from one class, `body.is-focused`, which it
 * keeps in step with the window itself: on desktop it runs
 * `body.toggleClass('is-focused', electronWindow.isFocused())` on every
 * `focuschange` (read from the 1.14.2 `app.js`). The title bar of an unfocused
 * window is darker, so a capture's bytes depended on something the harness does
 * not control. Measured in `obsidian-alias-quick-switcher` on 2026-09-25: five
 * back-to-back capture runs of an unchanged tree agreed byte for byte in runs
 * 2-5, and run 1 differed in EVERY desktop frame, in the title-bar band alone
 * (y 0-62, the full width, `rgb(29,29,29)` against `rgb(37,37,37)`). Windows'
 * focus-stealing prevention had refused the freshly launched window the
 * foreground, so the class was absent.
 *
 * **The class is pinned rather than the window focused.** Asking Electron for
 * `BrowserWindow.focus()` is a request the OS is free to refuse, which is the
 * same refusal that caused this; adding the class is deterministic and needs no
 * cooperation from anything. The frame then shows the focused chrome every run,
 * which is what the runs that got focus were already committing.
 *
 * **Restored afterwards, to what Obsidian itself would compute**, not to what it
 * was before: when focus arrives in the middle of a capture, Obsidian has
 * nothing left to toggle, so putting back a stale "absent" would leave a focused
 * window drawn unfocused. And only when this call added the class, so a window
 * that was focused all along is never touched.
 *
 * `captureObsidianScreenshot` calls this by default. It is exported for a
 * consumer capturing through a raw `connectToCdp` connection, the same reason
 * `hideCaret` and `hideVaultName` are.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type { EvalInObsidianParams } from './eval-in-obsidian.ts';
import type { ObsidianTransport } from './transport.ts';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { normalizeOptionalProperties } from './normalize-optional-properties.ts';

/**
 * What {@link pinWindowFocus} returns: whether the class had to be added, and
 * how to undo that.
 */
export interface PinnedWindowFocus {
  /**
   * Whether the window was drawn unfocused, so the class was added. `false`
   * means the window already carried it, and {@link restore} is then a no-op.
   */
  readonly isPinned: boolean;

  /**
   * Hands the class back to Obsidian: sets it to whether the window is
   * focused now, exactly as Obsidian's own `focuschange` handler would.
   *
   * @returns A {@link Promise} that resolves once the class is restored.
   */
  restore: () => Promise<void>;
}

/**
 * Options for {@link pinWindowFocus}.
 */
export interface PinWindowFocusOptions {
  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to pin. When omitted, the current test
   * context's vault is used.
   */
  readonly vaultPath?: string;
}

// Kept local rather than declared globally, like every other holder of a
// harness `window` property, so it never leaks into consumer types.
interface ElectronWindowHolder {
  electronWindow?: FocusReportingWindow;
}

interface FocusReportingWindow {
  isFocused: () => boolean;
}

/**
 * Adds `is-focused` to the body when the window is drawn unfocused.
 *
 * @param options - Transport and vault overrides.
 * @returns A {@link Promise} that resolves to the {@link PinnedWindowFocus}.
 */
export async function pinWindowFocus(options?: PinWindowFocusOptions): Promise<PinnedWindowFocus> {
  const { transport, vaultPath } = options ?? {};

  const isPinned = await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, boolean>>({
    callback(): boolean {
      if (document.body.hasClass('is-focused')) {
        return false;
      }

      document.body.addClass('is-focused');
      return true;
    },
    transport,
    vaultPath
  }));

  return {
    isPinned,
    async restore(): Promise<void> {
      if (!isPinned) {
        return;
      }

      await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, void>>({
        callback(): void {
          // The same expression Obsidian's own handler evaluates: the Electron
          // window's focus on desktop, the document's elsewhere.
          // eslint-disable-next-line no-restricted-syntax -- Approved double cast: `electronWindow` is Obsidian's own Window property, kept local rather than declared globally.
          const { electronWindow } = globalThis as unknown as ElectronWindowHolder;
          document.body.toggleClass('is-focused', electronWindow?.isFocused() ?? document.hasFocus());
        },
        transport,
        vaultPath
      }));
    }
  };
}

/* v8 ignore stop */
