import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  expect,
  it
} from 'vitest';

import { connectToCdp } from './connect-to-cdp.ts';

// The per-eval cap this test runs under, far below the layout wait: each readiness eval must be a short poll.
const COMMAND_TIMEOUT_IN_MILLISECONDS = 4000;
// How long the startup plugin holds `onload`, and with it Obsidian's layout: past the default 30 s readiness
// Budget, which before `vaultReadyTimeoutInMilliseconds` existed was the end of every such open.
const SLOW_ONLOAD_IN_MILLISECONDS = 40_000;
const VAULT_READY_TIMEOUT_IN_MILLISECONDS = 150_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 300_000;
const PLUGIN_ID = 'slow-layout-probe';

const PLUGIN_SOURCE = `const { Plugin } = require('obsidian');
class P extends Plugin {
  async onload() {
    await new Promise((resolve) => { window.setTimeout(resolve, ${String(SLOW_ONLOAD_IN_MILLISECONDS)}); });
    window.obsidianIntegrationTestingSlowLayout = { isFinished: true };
  }
}
module.exports = P; exports.default = P;
`;

/**
 * What the opened vault reported once `connectToCdp` returned.
 */
interface SlowLayoutState {
  /**
  Whether the slow plugin's `onload` finished.
  */
  readonly isOnloadFinished: boolean;

  /**
  `app.workspace.layoutReady`.
  */
  readonly layoutReady: boolean;
}

describe('a vault whose layout takes longer than the per-eval cap and the default readiness budget', () => {
  it('opens with a raised vaultReadyTimeoutInMilliseconds, its layout wait polled in short evals', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'slow-layout-vault-'));
    writeFileSync(join(vaultPath, 'note.md'), '# Slow layout\n');
    const pluginDirectory = join(vaultPath, '.obsidian', 'plugins', PLUGIN_ID);
    mkdirSync(pluginDirectory, { recursive: true });
    writeFileSync(join(pluginDirectory, 'main.js'), PLUGIN_SOURCE);
    writeFileSync(
      join(pluginDirectory, 'manifest.json'),
      JSON.stringify({
        author: 'obsidian-integration-testing',
        description: 'Holds onload, and so the layout, past the per-eval cap.',
        id: PLUGIN_ID,
        isDesktopOnly: false,
        minAppVersion: '1.0.0',
        name: PLUGIN_ID,
        version: '1.0.0'
      })
    );
    writeFileSync(join(vaultPath, '.obsidian', 'community-plugins.json'), JSON.stringify([PLUGIN_ID]));

    try {
      // The startup plugin is first loaded by the reload that turns community plugins on, so the
      // second readiness pass waits SLOW_ONLOAD_IN_MILLISECONDS for the layout, past the cap and past 30 s.
      const connection = await connectToCdp({
        commandTimeoutInMilliseconds: COMMAND_TIMEOUT_IN_MILLISECONDS,
        isObsidianAppVisible: false,
        shouldRemoveVaultOnDispose: false,
        vault: vaultPath,
        vaultReadyTimeoutInMilliseconds: VAULT_READY_TIMEOUT_IN_MILLISECONDS
      });
      try {
        const state = JSON.parse(
          await connection.invoke(
            'JSON.stringify({ isOnloadFinished: window.obsidianIntegrationTestingSlowLayout?.isFinished === true, layoutReady: app.workspace.layoutReady })'
          )
        ) as SlowLayoutState;
        expect(state).toEqual({ isOnloadFinished: true, layoutReady: true });
      } finally {
        await connection.dispose();
      }
    } finally {
      rmSync(vaultPath, { force: true, recursive: true });
    }
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
