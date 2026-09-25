import {
  readFile,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianTheme } from './apply-obsidian-theme.ts';

import { applyObsidianTheme } from './apply-obsidian-theme.ts';
import { captureObsidianScreenshot } from './capture-obsidian-screenshot.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { TemporaryVault } from './temporary-vault.ts';

interface ReloadProbe {
  appearanceReadCount: number;
  readonly originalReadConfigJson: (config: string) => Promise<null | object>;
}

// Kept local rather than declared globally, like every other holder of a test's
// own `window` property.
interface ReloadProbeHolder {
  __applyThemeReloadProbe?: ReloadProbe | undefined;
}

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;

/*
 * A vault built in-worker, so its config folder starts with no `appearance.json`
 * at all: the theme exists only where a save puts it, which is the state the
 * reload drops it from. The body starts in whatever theme Obsidian's `system`
 * default resolves to on this host, so every case works relative to it rather
 * than assuming light.
 */
const temporaryVault = new TemporaryVault();
let vaultPath: string;
let initialTheme: ObsidianTheme;
let otherTheme: ObsidianTheme;

beforeAll(async () => {
  await temporaryVault.register();
  vaultPath = temporaryVault.path;
  initialTheme = await readBodyTheme();
  otherTheme = initialTheme === 'dark' ? 'light' : 'dark';
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

describe('applyObsidianTheme integration', () => {
  // The control, and deliberately first, while the vault's disk carries no theme:
  // the race is real in this instance, or the case after it would pass for a
  // reload that never ran.
  it('should lose a bare changeTheme to a config reload that lands before the save', async () => {
    await evalInObsidian({
      callback({ app, themeName }): void {
        app.changeTheme(themeName);
      },
      input: { themeName: toThemeName(otherTheme) },
      vaultPath
    });

    await rewriteAppJson();

    await evalInObsidian({
      async callback({ bodyClass, lib: { waitUntil } }): Promise<void> {
        await waitUntil({
          message: 'the reload to drop the unsaved theme',
          predicate: () => document.body.classList.contains(bodyClass)
        });
      },
      input: { bodyClass: `theme-${initialTheme}` },
      vaultPath
    });
  });

  it('should keep the theme it applied through the same reload', async () => {
    await applyObsidianTheme({
      theme: otherTheme,
      vaultPath
    });
    expect(await readBodyTheme()).toBe(otherTheme);

    await installReloadProbe();
    try {
      await rewriteAppJson();
      await waitForReloadToRead();
    } finally {
      await removeReloadProbe();
    }

    expect(await readBodyTheme()).toBe(otherTheme);
  });

  it('should refuse a capture once the theme has left the one it applied', async () => {
    await applyObsidianTheme({
      theme: otherTheme,
      vaultPath
    });
    await evalInObsidian({
      callback({ app, themeName }): void {
        app.changeTheme(themeName);
      },
      input: { themeName: toThemeName(initialTheme) },
      vaultPath
    });

    await expect(captureObsidianScreenshot({ vaultPath })).rejects.toThrow(
      `Refusing to capture a screenshot: applyObsidianTheme applied the ${otherTheme} theme, but the body is now ${initialTheme}`
    );
    expect(await captureObsidianScreenshot({ shouldVerifyTheme: false, vaultPath })).toBeInstanceOf(Uint8Array);

    await applyObsidianTheme({
      theme: initialTheme,
      vaultPath
    });
    expect(await captureObsidianScreenshot({ vaultPath })).toBeInstanceOf(Uint8Array);
  });
});

/**
 * Wraps `readConfigJson` to count the `appearance.json` reads that COMPLETE.
 *
 * A reload that finds nothing to change fires no `config-changed` event, so the
 * case that proves the fix needs another signal that the reload ran. Its read of
 * `appearance.json` is its last await; the rest is synchronous, and the wrapper's
 * own `then` runs ahead of the reload's continuation, so by the time a poll sees
 * the count the reload has finished.
 */
async function installReloadProbe(): Promise<void> {
  await evalInObsidian({
    callback({ app }): void {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the probe is this suite's own Window property, kept local rather than declared globally.
      const holder = globalThis as unknown as ReloadProbeHolder;
      const originalReadConfigJson = app.vault.readConfigJson.bind(app.vault);
      const probe: ReloadProbe = {
        appearanceReadCount: 0,
        originalReadConfigJson
      };
      holder.__applyThemeReloadProbe = probe;
      app.vault.readConfigJson = async (config: string): Promise<null | object> => {
        const result = await originalReadConfigJson(config);
        if (config === 'appearance') {
          probe.appearanceReadCount++;
        }
        return result;
      };
    },
    vaultPath
  });
}

async function readBodyTheme(): Promise<ObsidianTheme> {
  return await evalInObsidian({
    callback(): ObsidianTheme {
      return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    },
    vaultPath
  });
}

async function removeReloadProbe(): Promise<void> {
  await evalInObsidian({
    callback({ app }): void {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the probe is this suite's own Window property, kept local rather than declared globally.
      const holder = globalThis as unknown as ReloadProbeHolder;
      if (holder.__applyThemeReloadProbe) {
        app.vault.readConfigJson = holder.__applyThemeReloadProbe.originalReadConfigJson;
      }
      holder.__applyThemeReloadProbe = undefined;
    },
    vaultPath
  });
}

/**
 * Rewrites `app.json` byte for byte from outside Obsidian, as a sync client or
 * a second tool would, so the only thing that changes is its mtime - which is
 * exactly what makes Obsidian's file watcher run `reloadConfig`.
 */
async function rewriteAppJson(): Promise<void> {
  const appJsonPath = join(vaultPath, '.obsidian', 'app.json');
  let content = '{}';
  try {
    content = await readFile(appJsonPath, 'utf-8');
  } catch {
    // Not written yet: an empty config reads the same to Obsidian.
  }
  await writeFile(appJsonPath, content);
}

function toThemeName(theme: ObsidianTheme): 'moonstone' | 'obsidian' {
  return theme === 'dark' ? 'obsidian' : 'moonstone';
}

async function waitForReloadToRead(): Promise<void> {
  await evalInObsidian({
    async callback({ lib: { waitUntil } }): Promise<void> {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the probe is this suite's own Window property, kept local rather than declared globally.
      const holder = globalThis as unknown as ReloadProbeHolder;
      await waitUntil({
        message: 'the config reload the app.json rewrite triggers to read appearance.json',
        predicate: () => (holder.__applyThemeReloadProbe?.appearanceReadCount ?? 0) > 0
      });
    },
    vaultPath
  });
}
