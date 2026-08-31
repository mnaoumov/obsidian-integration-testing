/**
 * @file
 *
 * The package's CLI. Two commands:
 *
 * - The **default** (no subcommand) — a thin CLI over {@link connectToCdp}: launches
 *   (or attaches to) a CDP-enabled Obsidian instance with the runtime helper
 *   namespace bootstrapped, prints the chosen CDP port/URL, and stays alive until
 *   interrupted so an external tool (raw CDP `ws`, DevTools, …) can attach.
 * - **`bootstrap-demo-vault`** — installs a demo vault's injected community plugins
 *   headlessly (see `demo-vault-bootstrap.ts`). This is the copy-pasteable remedy
 *   `buildDemoVaultPopulate`'s throw names, replacing the GUI-only "open
 *   `demo-vault/` in Obsidian once" step that a fresh clone or CI cannot perform.
 *
 * Anything that is not a recognized subcommand falls through to the default
 * command, so `obsidian-integration-testing --vault …` keeps working unchanged.
 */

/* v8 ignore start -- Integration-time CLI (launches Obsidian / CDP, downloads releases) covered manually, not by unit tests. */

import {
  existsSync,
  readdirSync
} from 'node:fs';
import {
  join,
  resolve as resolvePath
} from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import type { ConnectToCdpOptions } from './connect-to-cdp.ts';
import type { InjectPluginParams } from './demo-vault-populate.ts';

import { connectToCdp } from './connect-to-cdp.ts';
import { bootstrapDemoVaultPlugins } from './demo-vault-bootstrap.ts';

const BOOTSTRAP_DEMO_VAULT_COMMAND = 'bootstrap-demo-vault';
const HELP_FLAGS = new Set(['--help', '-h']);

/**
Index of a subcommand's first argument in `process.argv` (`[node, script, subcommand, …]`).
 */
const SUBCOMMAND_ARGUMENTS_START_INDEX = 3;

const USAGE = `Usage:
  obsidian-integration-testing [options]
      Launch (or attach to) a CDP-enabled Obsidian instance and print its endpoint.
      Options: --vault, --port, --host, --obsidian-version, --obsidian-installer-version,
               --command-timeout, --no-remove-vault

  obsidian-integration-testing ${BOOTSTRAP_DEMO_VAULT_COMMAND} [options]
      Install a demo vault's injected community plugins from their published GitHub
      releases, so integration tests run without opening Obsidian by hand.
      Options: --demo-vault <path>   demo vault directory (default: ./demo-vault)
               --plugin <id>         plugin id to install (repeatable; default: every
                                     id already present under .obsidian/plugins/)
               --repo <owner/name>   override the registry lookup (single --plugin only)
               --version <tag>       pin a release tag (single --plugin only)
               --force               re-download plugins that are already installed
`;

/**
 * The shape of the parsed CLI flag values.
 */
interface ParsedCliValues {
  'command-timeout'?: string | undefined;
  'host'?: string | undefined;
  'no-remove-vault'?: boolean | undefined;
  'obsidian-installer-version'?: string | undefined;
  'obsidian-version'?: string | undefined;
  'port'?: string | undefined;
  'vault'?: string | undefined;
}

/**
 * Dispatches to the requested subcommand, falling through to the default CDP
 * command for anything that is not one.
 *
 * @returns A {@link Promise} that resolves once the chosen command has finished.
 */
export async function main(): Promise<void> {
  const [, , firstArgument] = process.argv;

  if (firstArgument !== undefined && HELP_FLAGS.has(firstArgument)) {
    process.stdout.write(USAGE);
    return;
  }

  if (firstArgument === BOOTSTRAP_DEMO_VAULT_COMMAND) {
    await runBootstrapDemoVaultCommand(process.argv.slice(SUBCOMMAND_ARGUMENTS_START_INDEX));
    return;
  }

  await runConnectCommand();
}

/**
 * Builds {@link ConnectToCdpOptions} from parsed CLI flag values.
 *
 * @param values - The parsed `parseArgs` values.
 * @returns The connection options.
 */
function buildOptions(values: ParsedCliValues): ConnectToCdpOptions {
  return {
    ...(values['command-timeout'] !== undefined && { commandTimeoutInMilliseconds: parseNumber('command-timeout', values['command-timeout']) }),
    ...(values.host !== undefined && { host: values.host }),
    ...(values['no-remove-vault'] === true && { shouldRemoveVaultOnDispose: false }),
    ...(values['obsidian-installer-version'] !== undefined && { obsidianInstallerVersion: values['obsidian-installer-version'] }),
    ...(values['obsidian-version'] !== undefined && { obsidianVersion: values['obsidian-version'] }),
    ...(values.port !== undefined && { port: parseNumber('port', values.port) }),
    ...(values.vault !== undefined && { vault: values.vault })
  };
}

/**
 * Lists the plugin ids already present under a demo vault's `.obsidian/plugins/`, used as the default
 * install set when `--plugin` is omitted. A folder that exists but lacks `main.js` is exactly the state
 * this command repairs, so presence — not completeness — is the criterion.
 *
 * @param demoVaultPath - The demo vault root.
 * @returns The plugin ids, or an empty array when the vault has no plugins folder.
 */
function discoverDemoVaultPluginIds(demoVaultPath: string): string[] {
  const pluginsDirectory = join(demoVaultPath, '.obsidian', 'plugins');
  if (!existsSync(pluginsDirectory)) {
    return [];
  }
  return readdirSync(pluginsDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Parses a numeric CLI flag value, throwing on a non-finite result.
 *
 * @param flag - The flag name (for the error message).
 * @param raw - The raw string value.
 * @returns The parsed number.
 * @throws Error if `raw` is not a finite number.
 */
function parseNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`--${flag} must be a number, got: ${raw}`);
  }
  return value;
}

/**
 * Runs the `bootstrap-demo-vault` subcommand.
 *
 * @param commandArguments - The subcommand's arguments (everything after the subcommand name).
 * @returns A {@link Promise} that resolves once the install has finished.
 * @throws Error if no plugin ids can be determined, or `--repo` / `--version` are used with several plugins.
 */
async function runBootstrapDemoVaultCommand(commandArguments: string[]): Promise<void> {
  const { values } = parseArgs({
    // eslint-disable-next-line unicorn/name-replacements -- `args` is Node's own `parseArgs` option name.
    args: commandArguments,
    options: {
      'demo-vault': { type: 'string' },
      'force': { type: 'boolean' },
      'plugin': { multiple: true, type: 'string' },
      'repo': { type: 'string' },
      'version': { type: 'string' }
    }
  });

  const demoVaultPath = resolvePath(values['demo-vault'] ?? join(process.cwd(), 'demo-vault'));
  const pluginIds = values.plugin ?? discoverDemoVaultPluginIds(demoVaultPath);

  if (pluginIds.length === 0) {
    throw new Error(
      `No community plugins to install: ${demoVaultPath} has no .obsidian/plugins/ entries. `
        + 'Name them explicitly, e.g. --plugin fix-require-modules.'
    );
  }

  if (pluginIds.length > 1 && (values.repo !== undefined || values.version !== undefined)) {
    throw new Error('--repo and --version apply to a single plugin; pass exactly one --plugin, or run the command once per plugin.');
  }

  const injectPlugins: InjectPluginParams[] = pluginIds.map((pluginId) => ({
    pluginId,
    ...(values.repo !== undefined && { repo: values.repo }),
    ...(values.version !== undefined && { version: values.version })
  }));

  const result = await bootstrapDemoVaultPlugins({
    demoVaultPath,
    injectPlugins,
    shouldForce: values.force === true
  });

  for (const info of result.installed) {
    process.stdout.write(`Installed ${info.pluginId} from ${info.repo}@${info.version ?? 'latest'}: ${info.assetNames.join(', ')}\n`);
  }

  if (result.skippedPluginIds.length > 0) {
    process.stdout.write(`Already installed (use --force to re-download): ${result.skippedPluginIds.join(', ')}\n`);
  }

  if (result.installed.length === 0) {
    process.stdout.write('Nothing to install.\n');
  }
}

/**
 * Runs the default command: parses CLI arguments, opens the connection, prints its
 * endpoint, and blocks until `SIGINT`/`SIGTERM` or the owned Obsidian window is
 * closed, disposing the connection on shutdown.
 *
 * @returns A {@link Promise} that resolves once the connection has been disposed.
 */
async function runConnectCommand(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'command-timeout': { type: 'string' },
      'host': { type: 'string' },
      'no-remove-vault': { type: 'boolean' },
      'obsidian-installer-version': { type: 'string' },
      'obsidian-version': { type: 'string' },
      'port': { type: 'string' },
      'vault': { type: 'string' }
    }
  });

  const connection = await connectToCdp(buildOptions(values));

  process.stdout.write(
    'Obsidian CDP ready.\n'
      + `  port:   ${String(connection.port)}\n`
      + `  cdpUrl: ${connection.cdpUrl}\n`
      + `  vault:  ${connection.vault.path}\n`
      + 'Runtime helpers bootstrapped as window.__obsidianIntegrationTesting.\n'
      + 'Press Ctrl+C to stop.\n'
  );

  await waitForShutdownOrInstanceClose(connection.cdpUrl);

  process.stdout.write('\nShutting down…\n');
  await connection.dispose();
}

/**
 * Resolves once the process receives `SIGINT`/`SIGTERM`, or the CDP endpoint
 * stops answering (the owned Obsidian window was closed).
 *
 * @param cdpUrl - The connection's CDP base URL to poll.
 * @returns A {@link Promise} that resolves on the first shutdown trigger.
 */
function waitForShutdownOrInstanceClose(cdpUrl: string): Promise<void> {
  const POLL_INTERVAL_IN_MILLISECONDS = 1000;
  return new Promise<void>((resolve) => {
    const versionUrl = `${cdpUrl}/json/version`;
    let isSettled = false;

    const timer = setInterval(() => {
      probeAlive().catch(() => {
        // Ignore poll errors.
      });
    }, POLL_INTERVAL_IN_MILLISECONDS);

    process.once('SIGINT', settle);
    process.once('SIGTERM', settle);

    async function probeAlive(): Promise<void> {
      try {
        const response = await fetch(versionUrl);
        if (!response.ok) {
          settle();
        }
      } catch {
        // The CDP port stopped answering: the Obsidian window was closed.
        settle();
      }
    }

    function settle(): void {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearInterval(timer);
      resolve();
    }
  });
}

/* v8 ignore stop */
