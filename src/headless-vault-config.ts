/**
 * @file
 *
 * Writes the vault-level Obsidian settings a **headless** run needs into a
 * harness-owned vault's `app.json`, before that vault is ever opened.
 *
 * Both keys here are defaults rather than knobs: they are what a run with no
 * user in front of it wants unconditionally, so no consumer has to know the
 * internal exists. Neither is expressible through the transport options, and
 * neither is something a plugin under test should have to set for itself.
 *
 * - **`alwaysUpdateLinks: true`** — without it, any rename or move that affects
 *   links makes Obsidian's `FileManager.updateAllLinks` pop an interactive
 *   "Update links?" confirmation modal (it only skips the modal when this is
 *   on). Headless there is no user to answer it, so the Promise never resolves —
 *   the rename's internal `FileManager.updateQueue` task hangs forever, and
 *   because that queue is a singleton every subsequent `renameFile` in the
 *   shared instance hangs too (the long-observed "rename wall").
 * - **`settingsPopoutWindow: false`** — Obsidian ships this `true` (verified in
 *   the shipped bundles of both 1.13.7 and the 1.14.0 asar the harness
 *   provisions), and `app.setting.shouldUsePopout()` returns it directly. The
 *   popout branch is taken whenever `Platform.canPopoutWindow` — `isDesktopApp
 *   && isDesktop`, so every desktop run — and it puts the settings modal in a
 *   **second** Electron window, reassigning the `activeWindow` /
 *   `activeDocument` globals to it. A test that only asserts can still reach the
 *   rows through `settingTab.containerEl` (an object reference, wherever it
 *   lives), but a screenshot cannot: `captureObsidianScreenshot` photographs the
 *   main window, which holds none of the settings UI, and nothing throws to say
 *   so. Turning it off keeps the modal in the window the harness drives.
 *
 * The write **merges** into any existing `app.json` — one carried in by
 * `populate`, or seeded by a demo vault — so unrelated config survives, and it
 * runs before the vault is synced to the device so the values reach mobile too.
 */

import {
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_CONFIG_DIRECTORY } from './config-directory.ts';
import { log } from './log.ts';

const APP_JSON = 'app.json';
const APP_JSON_INDENT = 2;

/**
 * Parameters for {@link ensureHeadlessVaultConfig}.
 */
export interface EnsureHeadlessVaultConfigParams {
  /**
   * The vault's config folder name, when it is overridden away from
   * {@link DEFAULT_CONFIG_DIRECTORY}. Writing into `.obsidian` while the vault
   * reads `.obsidian-desktop` drops both defaults silently, so the override has
   * to reach this far.
   *
   * @default `'.obsidian'`
   */
  readonly configDirectory?: string | undefined;

  /**
   * The transport label, for logging.
   */
  readonly label: string;

  /**
   * The absolute path of the harness-owned vault to configure.
   */
  readonly vaultPath: string;
}

/**
 * Merges the headless defaults into `app.json`, creating the config folder and
 * the file when they do not exist yet.
 *
 * Only ever call this on a vault the harness owns. A caller-supplied vault is a
 * real one the user keeps, and silently rewriting its settings is not the
 * harness's to do.
 *
 * @param params - The vault to configure, its config folder, and the log label.
 */
export async function ensureHeadlessVaultConfig(params: EnsureHeadlessVaultConfigParams): Promise<void> {
  const { configDirectory = DEFAULT_CONFIG_DIRECTORY, label, vaultPath } = params;

  const configDirectoryPath = join(vaultPath, configDirectory);
  const appJsonPath = join(configDirectoryPath, APP_JSON);

  let appConfig: Record<string, unknown> = {};
  try {
    appConfig = JSON.parse(await readFile(appJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // No existing app.json (or unreadable) — start from an empty config.
  }

  appConfig['alwaysUpdateLinks'] = true;
  appConfig['settingsPopoutWindow'] = false;

  await mkdir(configDirectoryPath, { recursive: true });
  await writeFile(appJsonPath, JSON.stringify(appConfig, null, APP_JSON_INDENT));
  log(
    `[integration-setup:${label}] Wrote headless defaults to ${configDirectory}/${APP_JSON}`
      + ' (alwaysUpdateLinks: rename support; settingsPopoutWindow off: settings stay in the driven window).'
  );
}
