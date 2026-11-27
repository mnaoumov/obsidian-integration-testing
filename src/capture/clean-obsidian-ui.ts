/**
 * @file
 *
 * Hides the parts of Obsidian's chrome that a showcase frame does not need: the
 * ribbon, the status bar, the tab headers, the view header, the inline title,
 * and the two sidebars.
 *
 * Re-implemented from `cleanUi` in `obsidian-plugin-dev-kit`
 * (`src/e2e/demo/create-demo.ts`, `page-scripts.ts`, at aa82d95, MIT); no code
 * was copied. Each part takes the route Obsidian itself offers for it:
 *
 * - **The ribbon, the view header and the inline title are vault settings**
 *   (`showRibbon`, `showViewHeader`, `showInlineTitle`), set through
 *   `setConfig` and saved at once: a save left to Obsidian's own debounce is
 *   undone by a config reload that runs first (see `apply-obsidian-theme.ts`).
 * - **The status bar and the tab headers have no setting**, so a constructed
 *   `CSSStyleSheet` hides them, since the Obsidian lint forbids a `<style>`
 *   element.
 * - **The sidebars are collapsed** through the workspace's own splits.
 *
 * Everything is put back by the returned restore: a key the vault never
 * carried is deleted again rather than written as its default (see
 * `app-config.ts`), and only a sidebar this call collapsed is expanded.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type { ConfigItem } from '@obsidian-typings/obsidian-public-latest';

import type { EvalInObsidianParams } from '../eval/eval-in-obsidian.ts';
import type { ObsidianTransport } from '../transport/transport.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';

/**
 * What {@link cleanObsidianUi} returns.
 */
export interface CleanedObsidianUi {
  /**
   * Puts every part it hid back as it was.
   *
   * @returns A {@link Promise} that resolves once the chrome is restored.
   */
  readonly restore: () => Promise<void>;
}

/**
 * Which parts of the chrome {@link cleanObsidianUi} hides. `true` hides a part,
 * `false` leaves it as it is.
 */
export interface CleanObsidianUiOptions {
  /**
   * Hide the note's inline title.
   *
   * @default `true`
   */
  readonly inlineTitle?: boolean;

  /**
   * Hide the ribbon.
   *
   * @default `true`
   */
  readonly ribbon?: boolean;

  /**
   * Collapse the left and right sidebars.
   *
   * @default `true`
   */
  readonly sidebars?: boolean;

  /**
   * Hide the status bar.
   *
   * @default `true`
   */
  readonly statusBar?: boolean;

  /**
   * Hide the tab headers.
   *
   * @default `true`
   */
  readonly tabHeaders?: boolean;

  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to clean. When omitted, the current test
   * context's vault is used.
   */
  readonly vaultPath?: string;

  /**
   * Hide the view header above the note.
   *
   * @default `true`
   */
  readonly viewHeader?: boolean;
}

// A `window` property rather than a closure variable: the clean and the restore
// are two separate evaluations, and the sheet is not serializable. Kept local
// rather than declared globally, so it never leaks into consumer types.
interface CleanUiHolder {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Cleaning and restoring the chrome replaces and clears this window state.
  __obsidianIntegrationTestingCleanUi?: CleanUiRecord | undefined;
}

type CleanUiInput = Record<'hideInlineTitle' | 'hideRibbon' | 'hideSidebars' | 'hideStatusBar' | 'hideTabHeaders' | 'hideViewHeader', boolean>;

interface CleanUiRecord {
  readonly collapsedSplits: ('left' | 'right')[];
  readonly configs: SavedConfig[];
  readonly sheet: CSSStyleSheet | null;
}

interface SavedConfig {
  readonly isPresent: boolean;
  readonly key: string;
  readonly previousValue: unknown;
}

/**
 * Hides the chosen parts of Obsidian's chrome until the returned restore runs.
 *
 * A second clean before a restore first restores the first one, so cleans never
 * stack.
 *
 * @param options - Which parts to hide, and transport and vault overrides.
 * @returns A {@link Promise} that resolves to the {@link CleanedObsidianUi}.
 */
export async function cleanObsidianUi(options?: CleanObsidianUiOptions): Promise<CleanedObsidianUi> {
  const {
    inlineTitle = true,
    ribbon = true,
    sidebars = true,
    statusBar = true,
    tabHeaders = true,
    transport,
    vaultPath,
    viewHeader = true
  } = options ?? {};

  await restoreCleanUi(transport, vaultPath);

  await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<CleanUiInput, void>>({
    async callback({ app, hideInlineTitle, hideRibbon, hideSidebars, hideStatusBar, hideTabHeaders, hideViewHeader }): Promise<void> {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the clean-UI record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as CleanUiHolder;

      const configs: SavedConfig[] = [];
      const configKeys: [string, boolean][] = [
        ['showInlineTitle', hideInlineTitle],
        ['showRibbon', hideRibbon],
        ['showViewHeader', hideViewHeader]
      ];
      for (const [key, shouldHide] of configKeys) {
        if (!shouldHide) {
          continue;
        }
        const configItem = key as ConfigItem;
        const isPresent = Object.hasOwn(app.vault.config, key);
        configs.push({ isPresent, key, previousValue: isPresent ? app.vault.getConfig(configItem) : undefined });
        app.vault.setConfig(configItem, false);
      }
      if (configs.length > 0) {
        await app.vault.saveConfig();
      }

      const rules = [
        hideStatusBar ? '.status-bar { display: none !important; }' : '',
        hideTabHeaders ? '.workspace-tab-header-container { display: none !important; }' : ''
      ].filter((rule) => rule !== '');
      let sheet: CSSStyleSheet | null = null;
      if (rules.length > 0) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(rules.join('\n'));
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }

      const collapsedSplits: ('left' | 'right')[] = [];
      if (hideSidebars) {
        if (!app.workspace.leftSplit.collapsed) {
          app.workspace.leftSplit.collapse();
          collapsedSplits.push('left');
        }
        if (!app.workspace.rightSplit.collapsed) {
          app.workspace.rightSplit.collapse();
          collapsedSplits.push('right');
        }
      }

      holder.__obsidianIntegrationTestingCleanUi = { collapsedSplits, configs, sheet };
    },
    input: {
      hideInlineTitle: inlineTitle,
      hideRibbon: ribbon,
      hideSidebars: sidebars,
      hideStatusBar: statusBar,
      hideTabHeaders: tabHeaders,
      hideViewHeader: viewHeader
    },
    transport,
    vaultPath
  }));

  return {
    async restore(): Promise<void> {
      await restoreCleanUi(transport, vaultPath);
    }
  };
}

/**
 * Puts back whatever an earlier {@link cleanObsidianUi} hid, if anything.
 *
 * @param transport - The transport override.
 * @param vaultPath - The vault override.
 */
async function restoreCleanUi(transport: ObsidianTransport | undefined, vaultPath: string | undefined): Promise<void> {
  await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, void>>({
    async callback({ app }): Promise<void> {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the clean-UI record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as CleanUiHolder;
      const record = holder.__obsidianIntegrationTestingCleanUi;
      if (!record) {
        return;
      }
      holder.__obsidianIntegrationTestingCleanUi = undefined;

      for (const saved of record.configs) {
        // `undefined` is not a no-op: `setConfig` deletes the key for it, which
        // is the exact restore of a key the vault never carried.
        app.vault.setConfig(saved.key as ConfigItem, saved.isPresent ? saved.previousValue : undefined);
      }
      if (record.configs.length > 0) {
        await app.vault.saveConfig();
      }

      const { sheet } = record;
      if (sheet) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
      }

      for (const side of record.collapsedSplits) {
        (side === 'left' ? app.workspace.leftSplit : app.workspace.rightSplit).expand();
      }
    },
    transport,
    vaultPath
  }));
}

/* v8 ignore stop */
