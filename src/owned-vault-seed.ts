/**
 * @file
 *
 * Builds the isolated `obsidian.json` the harness pre-seeds into an owned
 * instance's temp `--user-data-dir` so Obsidian opens the harness vault directly
 * instead of showing the first-run vault-selector (the `starter-screen`).
 *
 * The auto-open marker changed across Obsidian's history, so the seed carries
 * BOTH forms and each version reads the one it understands (ignoring the other
 * unknown key) — no per-version branching:
 *
 * - **Old versions** (confirmed 0.6.4) auto-open from a **top-level `last_open`**
 *   holding the vault id (`main.js`: `if (id && vaults.hasOwnProperty(id))
 *   createWindow(id); else openStarter();`), and store each vault entry as just
 *   `{ path, ts }`. Without `last_open` they fall through to the vault-selector.
 * - **Newer versions** (confirmed 0.14.5+) dropped `last_open` and auto-open from
 *   the per-entry **`open: true`** flag.
 *
 * Seeding both was verified to open the vault directly (no selector) on 0.6.4,
 * 0.9.20, 0.12.19, 0.13.19, 0.14.5 and 1.12.7. `updateDisabled` suppresses the
 * throwaway instance's self-update.
 *
 * Both markers can also be **withheld** — see
 * {@link BuildOwnedObsidianJsonParams.shouldAutoOpenVault}. The one caller that
 * does so wants the starter screen on purpose: a `configDirectory` override is a
 * `localStorage` entry, and `localStorage` only exists once a renderer does, so
 * the override has to be written in the starter screen's renderer before the
 * vault's own window is created. The vault stays registered under the harness's
 * id either way, and the later `vault-open` IPC reuses that id (verified on
 * 1.13.7) rather than minting a second entry — which is what makes the
 * `<vaultId>-config` key name knowable before launch.
 */

/**
 * Parameters for {@link buildOwnedObsidianJson}.
 */
export interface BuildOwnedObsidianJsonParams {
  /**
   * Whether to include the auto-open markers, so Obsidian opens the vault
   * directly instead of showing the starter screen. Pass `false` to keep the
   * vault registered but closed — the caller then opens it itself, over the
   * `vault-open` IPC, once it has prepared the starter screen's renderer.
   *
   * @default `true`
   */
  readonly shouldAutoOpenVault?: boolean;

  /**
  Last-access timestamp to stamp on the vault entry.
   */
  readonly ts: number;

  /**
  The randomly-generated vault id used as the registry key and `last_open`.
   */
  readonly vaultId: string;

  /**
  Absolute path to the harness vault folder.
   */
  readonly vaultPath: string;
}

/**
 * The `obsidian.json` structure the harness seeds for an owned instance.
 */
export interface OwnedObsidianJson {
  /**
   * Top-level auto-open marker (vault id) honored by old Obsidian versions;
   * ignored as an unknown key by newer versions that use the per-entry `open`.
   * Omitted when the caller withheld the auto-open markers.
   */
  readonly last_open?: string;

  /**
  Disables the throwaway instance's self-update.
   */
  readonly updateDisabled: true;

  /**
  Vault registry keyed by vault id.
   */
  readonly vaults: Readonly<Record<string, OwnedObsidianVaultEntry>>;
}

/**
 * A single vault entry in the seeded `obsidian.json`.
 */
export interface OwnedObsidianVaultEntry {
  /**
   * Per-entry auto-open flag honored by newer Obsidian versions. Omitted when
   * the caller withheld the auto-open markers.
   */
  readonly open?: true;

  /**
  Absolute path to the harness vault folder.
   */
  readonly path: string;

  /**
  Last-access timestamp.
   */
  readonly ts: number;
}

/**
 * Builds the isolated `obsidian.json` that force-opens the owned vault across all
 * supported Obsidian versions (see the file overview for the dual-marker
 * rationale).
 *
 * @param params - The vault id, path, and timestamp to seed.
 * @returns The `obsidian.json` object to write into the owned user-data dir.
 */
export function buildOwnedObsidianJson(params: BuildOwnedObsidianJsonParams): OwnedObsidianJson {
  const shouldAutoOpenVault = params.shouldAutoOpenVault ?? true;
  const entry: OwnedObsidianVaultEntry = shouldAutoOpenVault
    ? { open: true, path: params.vaultPath, ts: params.ts }
    : { path: params.vaultPath, ts: params.ts };

  return {
    // Spread rather than `last_open: undefined`, so the key is genuinely absent from
    // The written JSON: this seed is read by Obsidian versions spanning a decade, and
    // A present-but-undefined auto-open marker is not a shape any of them was tested
    // Against.
    // eslint-disable-next-line camelcase -- Obsidian's own obsidian.json field name (old versions' auto-open marker).
    ...shouldAutoOpenVault && { last_open: params.vaultId },
    updateDisabled: true,
    vaults: { [params.vaultId]: entry }
  };
}
