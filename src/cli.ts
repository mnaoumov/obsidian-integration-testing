/**
 * @file
 *
 * Thin CLI over {@link connectToCdp}: launches (or attaches to) a CDP-enabled
 * Obsidian instance with the runtime helper namespace bootstrapped, prints the
 * chosen CDP port/URL, and stays alive until interrupted so an external tool
 * (raw CDP `ws`, DevTools, …) can attach.
 */

/* v8 ignore start -- Integration-time CLI (launches Obsidian / CDP) covered manually, not by unit tests. */

import process from 'node:process';
import { parseArgs } from 'node:util';

import type { ConnectToCdpOptions } from './connect-to-cdp.ts';

import { connectToCdp } from './connect-to-cdp.ts';

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
 * Parses CLI arguments, opens the connection, prints its endpoint, and blocks
 * until `SIGINT`/`SIGTERM`, disposing the connection on shutdown.
 *
 * @returns A {@link Promise} that resolves once the connection has been disposed.
 */
export async function main(): Promise<void> {
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

  await waitForShutdownSignal();

  process.stdout.write('\nShutting down…\n');
  await connection.dispose();
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
    throw new Error(`--${flag} must be a number, got: ${raw}`);
  }
  return value;
}

/**
 * Resolves once the process receives `SIGINT` or `SIGTERM`.
 *
 * @returns A {@link Promise} that resolves on the first shutdown signal.
 */
function waitForShutdownSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      resolve();
    });
    process.once('SIGTERM', () => {
      resolve();
    });
  });
}

/* v8 ignore stop */
