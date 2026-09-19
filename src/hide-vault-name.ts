/**
 * @file
 *
 * Hides every element that renders the vault's NAME, so a captured frame does
 * not depend on which temporary vault the run happened to get.
 *
 * The harness names its temporary vaults `temp-vault-<random>`, and Obsidian
 * prints that name in the vault-switcher row at the bottom of the left sidedock.
 * A desktop capture therefore carries the random suffix, which makes the PNG
 * differ on every run — measured as 349 differing pixels in `x:153-197
 * y:774-783` of a 1200x800 frame, amplified 16x to read `temp-vault-` plus
 * that run's six-character suffix.
 * The caption band `labelScreenshot` draws over that strip attenuates it to
 * about 6 % brightness rather than hiding it, so it is invisible to a reader
 * and fatal to reproducibility: a capture suite rewrites its checked-in
 * screenshots on every run and the diff is unreadable.
 *
 * `captureObsidianScreenshot` calls this by default, so a consumer gets a
 * reproducible frame without knowing the helper exists. It is exported anyway,
 * for a consumer capturing through a raw `connectToCdp` connection — the same
 * reason `measureLabelCaption` is exported rather than kept private to the
 * labeller.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type { EvalInObsidianParams } from './eval-in-obsidian.ts';
import type { ObsidianTransport } from './transport.ts';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { normalizeOptionalProperties } from './normalize-optional-properties.ts';

/**
 * Options for {@link hideVaultName}.
 */
export interface HideVaultNameOptions {
  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to hide the name in. When omitted, the
   * current test context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * Hides every element whose text is exactly the vault's name.
 *
 * Keyed on `app.vault.getName()` rather than on a class of Obsidian's chrome,
 * deliberately: the varying thing is the DATA, and the row that renders it has
 * moved between Obsidian versions before. Obsidian's own `hide()` rather than an
 * inline `style.visibility` or an injected stylesheet, because those are what
 * `obsidianmd/no-static-styles-assignment` and `obsidianmd/no-forbidden-elements`
 * respectively refuse.
 *
 * Only leaf elements match (`childElementCount === 0`), so an ancestor whose
 * `textContent` happens to concatenate to the same string is left alone — on a
 * vault named after the only note in it, hiding the ancestor would blank half
 * the frame.
 *
 * **Idempotent, and meant to be re-applied.** `hide()` leaves the text in place,
 * so a second call finds what the first one hid; and it has to, because a
 * re-render of the sidedock between two captures puts the row back.
 *
 * **Not asserted here.** Zero is a legitimate answer — the mobile app renders no
 * vault-switcher row at all — so the count is returned rather than checked. A
 * desktop capture suite that wants to fail loudly when Obsidian relocates the
 * row should assert on it itself.
 *
 * @param options - Transport and vault overrides.
 * @returns A {@link Promise} that resolves to the number of elements hidden.
 */
export async function hideVaultName(options?: HideVaultNameOptions): Promise<number> {
  const { transport, vaultPath } = options ?? {};

  return await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, number>>({
    callback({ app }): number {
      const vaultName = app.vault.getName();
      const vaultNameEls = [...document.querySelectorAll('*')]
        .filter((el): el is HTMLElement => el.instanceOf(HTMLElement) && el.childElementCount === 0 && el.textContent === vaultName);

      for (const vaultNameEl of vaultNameEls) {
        vaultNameEl.hide();
      }

      return vaultNameEls.length;
    },
    transport,
    vaultPath
  }));
}

/* v8 ignore stop */
