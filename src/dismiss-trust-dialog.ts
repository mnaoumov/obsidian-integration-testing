/**
 * @file
 *
 * Provides the JavaScript expression evaluated inside Obsidian to dismiss the
 * "Do you trust the author of this vault?" modal that appears when a vault
 * with community plugins is opened without a prior `enable-plugin-<id>`
 * entry in `localStorage`.
 *
 * Shared between desktop transports (CLI + CDP) because the modal markup and
 * close mechanism are identical regardless of how the eval is delivered.
 *
 * Cross-version compatibility (verified against Obsidian 1.12.7 and 1.13.0):
 *
 * - `Modal` (the base class) always creates an X-icon element wired to
 *   `Modal.close()`. The class name changed across versions:
 *     - 1.12.x and earlier: `.modal-close-button`
 *     - 1.13.0+:            `.modal-header-button`
 *   Clicking it removes the container from the DOM with no side effects —
 *   the only universal exit. The dialog's own action buttons are not safe to
 *   rely on: in 1.12.7 they have no marker classes at all and the cancel
 *   button writes `localStorage = "false"` (permanently disabling plugins).
 *   In 1.13.0 the cancel button has `.mod-cancel` and the action button has
 *   no marker class; clicking the action button asynchronously opens the
 *   Settings modal as a side effect.
 *
 * - We also write `enable-plugin-<appId>` to `"true"` directly. Plugins are
 *   loaded lazily by `evalWrapper` / `enablePluginWithErrorCapture` on the
 *   first eval that needs them, so we deliberately avoid calling
 *   `setEnable(true)` here — it would synchronously trigger plugin load,
 *   queuing every subsequent eval (including `destroyCurrentWindow`) behind
 *   it and pushing teardown past test hook timeouts.
 *
 * Returns the string `'true'` if a dialog was found and dismissed, `'false'`
 * otherwise. The evaluator stringifies the boolean.
 */

export const DISMISS_TRUST_DIALOG_EXPR = `(function() {
  var modals = document.querySelectorAll('.modal-container');
  for (var i = 0; i < modals.length; i++) {
    var modal = modals[i];
    if (!modal.textContent.includes('Do you trust the author')) { continue; }
    try {
      var appId = window.app && window.app.appId;
      if (appId) { localStorage.setItem('enable-plugin-' + appId, 'true'); }
    } catch (e) { /* localStorage may be unavailable in edge cases */ }
    var closeBtn = modal.querySelector('.modal-close-button, .modal-header-button');
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
  }
  return false;
})()`;
