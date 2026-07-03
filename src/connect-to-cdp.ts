/**
 * @file
 *
 * Programmatic helper to launch (or attach to) a CDP-enabled Obsidian instance
 * with the runtime helper namespace bootstrapped, for ad-hoc real-app debugging.
 *
 * A single {@link connectToCdp} call resolves the owned-instance config, opens a
 * vault, and bootstraps `window.__obsidianIntegrationTesting` (so `evalWrapper`,
 * `typeIntoEditor`, `serializeError`, `getObsidianModule`, … are available), then
 * hands back a disposable {@link CdpConnection} exposing the chosen CDP port, a
 * raw {@link CdpConnection.invoke} and the rich {@link CdpConnection.evalInObsidian}.
 */

/* v8 ignore start -- Integration-time code (launches Obsidian / CDP) covered by integration tests, not unit tests. */

import type { Except } from 'type-fest';

import type { ContextId } from './context-id.ts';
import type {
  EvalInObsidianParams,
  GenericObject
} from './eval-in-obsidian.ts';
import type { ObsidianCdpTransportOptions } from './transport-options.ts';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { TempVault } from './temp-vault.ts';
import { DesktopCdpTransport } from './transport-desktop-cdp.ts';
import { createTransportFromOptions } from './transport-factory.ts';

const DEFAULT_CDP_HOST = 'localhost';

/**
 * A live connection to a CDP-enabled Obsidian instance with the runtime helper
 * namespace bootstrapped.
 *
 * Implements `AsyncDisposable`, so `await using conn = await connectToCdp(…)`
 * disposes it (killing an owned instance and — for a throw-away temp vault —
 * removing its directory) automatically.
 */
export interface CdpConnection extends AsyncDisposable {
  /**
   * The base CDP URL, e.g. `http://localhost:51888`.
   */
  readonly cdpUrl: string;

  /**
   * Disposes the connection: kills an owned instance and removes its isolated
   * user-data dir. The vault directory is removed only when it is a throw-away
   * temp vault (see {@link ConnectToCdpOptions.shouldRemoveVaultOnDispose}); a
   * real vault passed via {@link ConnectToCdpOptions.vault} is never deleted.
   *
   * @returns A {@link Promise} that resolves once disposal completes.
   */
  dispose(): Promise<void>;

  /**
   * Evaluates a self-contained function inside Obsidian via the rich helper
   * path, receiving `{ app, obsidianModule, typeIntoEditor, context }` plus any
   * `args`. Mirrors the top-level `evalInObsidian`, with the transport and vault
   * path pre-bound to this connection.
   *
   * @param params - The evaluation parameters (`fn`, optional `args`/`contextId`).
   * @returns A {@link Promise} that resolves to the return value of `fn`.
   */
  evalInObsidian<Args extends GenericObject, Result, TContextId extends ContextId<unknown> | undefined = undefined>(
    params: Except<EvalInObsidianParams<Args, Result, TContextId>, 'transport' | 'vaultPath'>
  ): Promise<Result>;

  /**
   * Evaluates a raw JavaScript expression inside Obsidian and returns the
   * normalized string result (e.g. `'5'`, a JSON string, or `'(no output)'`).
   *
   * @param expression - A self-contained JavaScript expression.
   * @returns A {@link Promise} that resolves to the raw result string.
   */
  invoke(expression: string): Promise<string>;

  /**
   * The CDP port the instance is reachable on (the free port chosen for an
   * owned instance, or the attached {@link ConnectToCdpOptions.port}).
   */
  readonly port: number;

  /**
   * The opened vault. Exposes `path` and `populate(...)` for seeding files.
   */
  readonly vault: TempVault;
}

/**
 * Options for {@link connectToCdp}.
 */
export interface ConnectToCdpOptions {
  /**
   * Timeout in milliseconds for individual CDP commands.
   *
   * @default `30000`
   */
  readonly commandTimeoutInMilliseconds?: number;

  /**
   * CDP host.
   *
   * @default `'localhost'`
   */
  readonly host?: string;

  /**
   * Pins the Electron shell (installer build) the owned instance runs. Accepts
   * `'x.y.z'`, `'public-latest'`, or `'catalyst-latest'`. Ignored when
   * {@link port} (attach mode) is set. When omitted, the installed shell is used.
   *
   * @default `undefined`
   */
  readonly obsidianInstallerVersion?: string;

  /**
   * Pins the Obsidian app version (asar) the owned instance runs. Accepts
   * `'x.y.z'`, `'public-latest'`, or `'catalyst-latest'`. Ignored when
   * {@link port} (attach mode) is set. When omitted, the installed version is used.
   *
   * @default `undefined`
   */
  readonly obsidianVersion?: string;

  /**
   * CDP port of an already-running Obsidian to **attach** to. When omitted, an
   * isolated instance is launched on an automatically chosen free port.
   *
   * @default `undefined`
   */
  readonly port?: number;

  /**
   * Whether to remove the vault directory on {@link CdpConnection.dispose}.
   *
   * When omitted, defaults to `true` for an implicit throw-away temp vault
   * ({@link vault} not given) and `false` when a {@link vault} path is given, so
   * a real vault is never deleted. Set explicitly to override.
   */
  readonly shouldRemoveVaultOnDispose?: boolean;

  /**
   * Absolute path to an existing vault to open. When omitted, an empty temporary
   * vault is created (and removed on dispose unless
   * {@link shouldRemoveVaultOnDispose} says otherwise).
   *
   * @default `undefined`
   */
  readonly vault?: string;
}

/**
 * A resolved CDP host/port pair.
 */
interface ResolvedEndpoint {
  host: string;
  port: number;
}

/**
 * Launches (or attaches to) a CDP-enabled Obsidian instance, opens a vault, and
 * bootstraps the runtime helper namespace, returning a disposable connection.
 *
 * @param options - Connection options.
 * @returns A {@link Promise} that resolves to the live {@link CdpConnection}.
 */
export async function connectToCdp(options?: ConnectToCdpOptions): Promise<CdpConnection> {
  const transportOptions: ObsidianCdpTransportOptions = {
    type: 'obsidian-cdp',
    ...(options?.commandTimeoutInMilliseconds !== undefined && { commandTimeoutInMilliseconds: options.commandTimeoutInMilliseconds }),
    ...(options?.host !== undefined && { host: options.host }),
    ...(options?.obsidianInstallerVersion !== undefined && { obsidianInstallerVersion: options.obsidianInstallerVersion }),
    ...(options?.obsidianVersion !== undefined && { obsidianVersion: options.obsidianVersion }),
    ...(options?.port !== undefined && { port: options.port })
  };

  const transport = await createTransportFromOptions(transportOptions);
  const vault = new TempVault(options?.vault);
  const shouldRemoveVaultOnDispose = options?.shouldRemoveVaultOnDispose ?? (options?.vault === undefined);

  // Registering the vault is what launches the owned instance (provisions the
  // Asar, opens the vault, and bootstraps the helper namespace), or opens the
  // Vault in the attached instance.
  await vault.register(transport);

  const { host, port } = resolveEndpoint(transport, options);
  const cdpUrl = `http://${host}:${String(port)}`;

  const connection: CdpConnection = {
    cdpUrl,

    async dispose(): Promise<void> {
      try {
        if (shouldRemoveVaultOnDispose) {
          await vault.dispose(transport);
        } else {
          await transport.unregisterVault(vault.path);
        }
      } finally {
        await transport.dispose?.();
      }
    },

    async evalInObsidian<Args extends GenericObject, Result, TContextId extends ContextId<unknown> | undefined = undefined>(
      params: Except<EvalInObsidianParams<Args, Result, TContextId>, 'transport' | 'vaultPath'>
    ): Promise<Result> {
      return evalInObsidian<Args, Result, TContextId>({ ...params, transport, vaultPath: vault.path });
    },

    async invoke(expression: string): Promise<string> {
      return transport.evaluate(expression, { cwd: vault.path });
    },

    port,

    async [Symbol.asyncDispose](): Promise<void> {
      await connection.dispose();
    },

    vault
  };

  return connection;
}

/**
 * Resolves the CDP host/port for the connection: from the owned instance's
 * launched endpoint when present, otherwise from the attach options.
 *
 * @param transport - The transport created for this connection.
 * @param options - The connection options.
 * @returns The resolved host and port.
 * @throws Error if the port cannot be determined.
 */
function resolveEndpoint(transport: unknown, options: ConnectToCdpOptions | undefined): ResolvedEndpoint {
  if (transport instanceof DesktopCdpTransport) {
    const endpoint = transport.getOwnedInstanceEndpoint();
    if (endpoint) {
      return { host: endpoint.host, port: endpoint.port };
    }
  }

  if (options?.port !== undefined) {
    return { host: options.host ?? DEFAULT_CDP_HOST, port: options.port };
  }

  throw new Error('connectToCdp: could not determine the CDP port.');
}

/* v8 ignore stop */
