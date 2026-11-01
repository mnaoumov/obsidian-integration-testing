/**
 * @file
 *
 * Pure decision for whether unregistering a vault may tear its window down.
 *
 * The desktop CDP transport used to answer this with a single flag. Its
 * readiness guard asks `ownedConfig || isHarnessOwnedInstance` — the two ways
 * "the harness owns this instance" can be true — while its teardown guard asked
 * only `ownedConfig`. A **worker** attached to a harness-owned instance has
 * `isHarnessOwnedInstance: true` and no `ownedConfig` at all (the global setup
 * owns the config; the worker was handed only the port), so it fell straight
 * through the teardown guard and ran `destroyCurrentWindow()` against the vault
 * it was asked to unregister. When that vault is the one the whole run shares,
 * its window is the only one — destroying it quits the app, and every later file
 * fails with `ECONNREFUSED` on a closed CDP port, which reads as a harness
 * outage rather than as a teardown that overreached.
 *
 * Making the two guards identical would fix that and break something else: an
 * attached worker that registers its **own** `TemporaryVault` does need that
 * window closed, and a blanket early-return leaks one stale window per temp
 * vault for the life of the run — each pointing at a directory the disposal has
 * already deleted. Since every worker in a `createSetup` run is an attached one,
 * that is the common path, not an edge case.
 *
 * So the invariant is narrower than either guard expressed: **a worker attached
 * to a harness-owned instance may tear down only a vault it registered itself.**
 * Everything else in that instance belongs to the global setup that launched it.
 *
 * Plain attach mode — `connectToCdp({ port })` against somebody's own running
 * Obsidian — takes the same rule, and needs it more. It used to tear down
 * whatever it was asked to, so attaching to the owner's running Obsidian with
 * `vault` set to the vault it already had open destroyed that vault's window on
 * dispose: his only window, so the app quit. "Self-registered" now means this
 * transport opened the window itself; a vault that was already open is adopted
 * and never recorded, so nothing here closes it.
 *
 * Kept out of the integration-only transport module (excluded from unit tests,
 * `LF:0` in coverage) for the same reason `vault-path-match.ts` is — so the
 * decision is unit-testable while the transport keeps only the plumbing.
 */

/**
 * Parameters for {@link shouldTearDownVaultWindow}.
 */
export interface ShouldTearDownVaultWindowParams {
  /**
  Whether this transport launched and owns the instance itself.
   */
  readonly isOwnedInstance: boolean;

  /**
  Whether this transport opened the window of the vault being unregistered itself.
   */
  readonly isSelfRegistered: boolean;
}

/**
 * Whether unregistering a vault may destroy its window and remove it from the
 * registry, or must leave the instance untouched.
 *
 * @param params - Who owns the instance, and who registered the vault.
 * @returns `true` when the window may be torn down.
 */
export function shouldTearDownVaultWindow(params: ShouldTearDownVaultWindowParams): boolean {
  const {
    isOwnedInstance,
    isSelfRegistered
  } = params;

  /*
   * The owned instance is killed wholesale on dispose, and its registry lives in the isolated user-data config —
   * there is nothing to unregister from. Attached to anyone else's instance, the harness's or a foreign one that
   * outlives the run, only a window this transport opened comes down; everything else is left as it was found.
   */
  return !isOwnedInstance && isSelfRegistered;
}
