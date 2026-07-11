/**
 * @file
 *
 * Launches and manages a harness-owned, isolated Obsidian desktop instance.
 *
 * The instance runs against a dedicated `--user-data-dir` (so it never touches
 * the user's Obsidian config, registry, or running window) and exposes CDP on a
 * dedicated `--remote-debugging-port`. Because Electron's single-instance lock
 * is keyed to the user-data dir, the owned instance runs in parallel with the
 * user's own Obsidian. Confirmed by the Phase 0 spike (see the project plan).
 */

/* v8 ignore start -- Integration-time process management covered by integration tests, not unit tests. */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import { killProcessTree } from './kill-process-tree.ts';
import { log } from './log.ts';

/**
 * Parameters for {@link launchOwnedObsidianInstance}.
 */
export interface LaunchOwnedObsidianInstanceParams {
  /**
   * CDP host to bind/poll.
   *
   * @default `'127.0.0.1'`
   */
  readonly cdpHost?: string;

  /** Absolute path to the Obsidian executable (shell) to launch. */
  readonly exePath: string;

  /**
   * Extra command-line args appended after `--user-data-dir` and
   * `--remote-debugging-port` — used to pass the keep-alive Chromium flags when
   * the instance is launched hidden (off-screen). Empty by default.
   */
  readonly extraArgs?: readonly string[];

  /** Absolute path to the isolated user-data dir to pass via `--user-data-dir`. */
  readonly userDataDir: string;
}

/**
 * A running, harness-owned Obsidian instance.
 */
export interface OwnedObsidianInstance {
  /** Base CDP URL, e.g. `http://127.0.0.1:51888`. */
  readonly cdpUrl: string;

  /** Kills the instance and its entire process tree. */
  kill(): void;

  /** The CDP remote-debugging port the instance was launched with. */
  readonly port: number;
}

const DEFAULT_CDP_HOST = '127.0.0.1';
const CDP_READY_POLL_INTERVAL_IN_MILLISECONDS = 1000;
const CDP_READY_TIMEOUT_IN_MILLISECONDS = 60000;

interface CdpTarget {
  type: string;
}

/**
 * Launches an isolated, harness-owned Obsidian instance and waits until its CDP
 * endpoint is serving page targets.
 *
 * @param params - Launch parameters.
 * @returns The running owned instance.
 * @throws Error if CDP does not become reachable within the timeout.
 */
export async function launchOwnedObsidianInstance(
  params: LaunchOwnedObsidianInstanceParams
): Promise<OwnedObsidianInstance> {
  const cdpHost = params.cdpHost ?? DEFAULT_CDP_HOST;
  const port = await pickFreePort();
  const cdpUrl = `http://${cdpHost}:${String(port)}`;

  log(`[obsidian-instance] Launching owned Obsidian: userData=${params.userDataDir}, cdpPort=${String(port)}`);
  const child = spawn(
    params.exePath,
    [`--user-data-dir=${params.userDataDir}`, `--remote-debugging-port=${String(port)}`, ...(params.extraArgs ?? [])],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  try {
    await waitForCdpReady(cdpUrl);
    log(`[obsidian-instance] Owned Obsidian is serving CDP at ${cdpUrl}.`);
    return { cdpUrl, kill, port };
  } catch (error: unknown) {
    kill();
    throw error;
  }

  function kill(): void {
    killProcessTree(child);
  }
}

/**
 * Picks a free TCP port by binding to port `0` and reading the assigned port.
 *
 * There is a small time-of-check/time-of-use window between releasing the port
 * here and Obsidian binding it; in practice it is negligible for test runs.
 *
 * @returns A free TCP port.
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, DEFAULT_CDP_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to determine a free port.'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Returns a promise that resolves after the given delay.
 *
 * @param ms - The delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polls the CDP `/json` endpoint until at least one page target appears.
 *
 * @param cdpUrl - The base CDP URL.
 */
async function waitForCdpReady(cdpUrl: string): Promise<void> {
  const deadline = Date.now() + CDP_READY_TIMEOUT_IN_MILLISECONDS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json`);
      const targets = await response.json() as CdpTarget[];
      if (targets.some((target) => target.type === 'page')) {
        return;
      }
    } catch {
      // Endpoint not up yet — keep polling.
    }
    await delay(CDP_READY_POLL_INTERVAL_IN_MILLISECONDS);
  }
  throw new Error(
    `Owned Obsidian instance did not expose CDP at ${cdpUrl} within ${String(CDP_READY_TIMEOUT_IN_MILLISECONDS)}ms.`
  );
}

/* v8 ignore stop */
