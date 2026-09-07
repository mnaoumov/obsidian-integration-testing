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

import type { ProcessExitInfo } from './process-exit-message.ts';

import { killProcessTree } from './kill-process-tree.ts';
import { log } from './log.ts';
import {
  clearOwnedInstanceExitMarker,
  writeOwnedInstanceExitMarker
} from './owned-instance-exit-marker.ts';
import { OwnedInstanceExitedError } from './owned-instance-exited-error.ts';
import { startParentLivenessServer } from './parent-liveness.ts';
import { attachProcessCapture } from './process-capture.ts';

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

  /**
  Absolute path to the Obsidian executable (shell) to launch.
   */
  readonly exePath: string;

  /**
   * Extra command-line arguments appended after `--user-data-dir` and
   * `--remote-debugging-port` — used to pass the keep-alive Chromium flags when
   * the instance is launched hidden (off-screen). Empty by default.
   */
  readonly extraArguments?: readonly string[];

  /**
  Absolute path to the isolated user-data dir to pass via `--user-data-dir`.
   */

  readonly userDataDirectory: string;
}

/**
 * A running, harness-owned Obsidian instance.
 */
export interface OwnedObsidianInstance {
  /**
  Base CDP URL, e.g. `http://127.0.0.1:51888`.
   */
  readonly cdpUrl: string;

  /**
  Kills the instance and its entire process tree.
   */
  kill(): void;

  /**
   * Loopback port the instance's renderer connects back to so it destroys
   * itself if this harness process dies without cleaning up. See
   * `parent-liveness.ts` for why the parent/child relationship alone is not
   * enough.
   */
  readonly parentLivenessPort: number;

  /**
  The CDP remote-debugging port the instance was launched with.
   */
  readonly port: number;

  /**
   * Returns how the instance died once it is no longer running, otherwise
   * `undefined`. This is the in-process half of the answer; a test worker in
   * another process reads the same facts from the exit marker
   * (`owned-instance-exit-marker.ts`).
   */
  readExitInfo(): ProcessExitInfo | undefined;

  /**
  Returns the tail of everything the instance wrote to stdout/stderr.
   */
  readOutput(): string;
}

const DEFAULT_CDP_HOST = '127.0.0.1';
const CDP_READY_POLL_INTERVAL_IN_MILLISECONDS = 1000;
const CDP_READY_TIMEOUT_IN_MILLISECONDS = 60_000;
const OBSIDIAN_OUTPUT_TAIL_MAX_LENGTH = 8000;

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

  // Listen BEFORE spawning, so the renderer watchdog can never race the server
  // Into a failed connect (which it treats as "no watchdog", leaving the instance alive).
  const livenessServer = await startParentLivenessServer();

  // Ports are recycled by the OS, so an older instance's death recorded on this
  // Port would otherwise be read as this one's.
  clearOwnedInstanceExitMarker(port);

  log(`[obsidian-instance] Launching owned Obsidian: userData=${params.userDataDirectory}, cdpPort=${String(port)}`);
  /*
   * Piped rather than `'ignore'`: an Electron/Chromium fatal is written to
   * stderr and nowhere else, and discarding it is why a dying instance used to
   * be indistinguishable from a healthy one. The capture drains both pipes for
   * the process's whole life (a full pipe buffer would block the app itself) and
   * keeps only a bounded tail.
   */
  const child = spawn(
    params.exePath,
    [`--user-data-dir=${params.userDataDirectory}`, `--remote-debugging-port=${String(port)}`, ...(params.extraArguments ?? [])],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const capture = attachProcessCapture(child, {
    maxOutputLengthInCharacters: OBSIDIAN_OUTPUT_TAIL_MAX_LENGTH,
    onChunk: (chunk) => {
      const text = chunk.text.trimEnd();
      if (text.length > 0) {
        log(`[obsidian-instance:${chunk.stream}] ${text}`);
      }
    }
  });

  // Set by `kill()`, so a death the harness ordered is never reported as one it
  // Suffered — a marker left by a clean teardown would convict the next run's
  // Healthy instance of an exit that never happened.
  let isKillExpected = false;

  child.once('exit', (code: null | number, signal: NodeJS.Signals | null) => {
    if (isKillExpected) {
      log(`[obsidian-instance] Owned Obsidian exited as asked: pid=${String(child.pid)} code=${String(code)} signal=${String(signal)}`);
      return;
    }

    // Loud on purpose. This one line is what separates a clean quit from a
    // Crash, and its absence once cost a day of guessing.
    log(`[obsidian-instance] !!! OWNED OBSIDIAN EXITED: pid=${String(child.pid)} code=${String(code)} signal=${String(signal)}`);
    writeOwnedInstanceExitMarker({
      code,
      outputTail: capture.readOutput(),
      pid: child.pid,
      port,
      signal
    });
  });

  child.unref();

  try {
    await waitForCdpReady(cdpUrl);
    log(`[obsidian-instance] Owned Obsidian is serving CDP at ${cdpUrl}.`);
    return {
      cdpUrl,
      kill,
      parentLivenessPort: livenessServer.port,
      port,
      readExitInfo: () => capture.readExitInfo(),
      readOutput: () => capture.readOutput()
    };
  } catch (error: unknown) {
    /*
     * Read before killing, so the verdict is the instance's own. A CDP timeout
     * whose process is already gone is not a slow boot — it is a boot that
     * ended — and saying so beats reporting only the budget it blew.
     *
     * Deliberately NOT a fast-fail inside the poll: on some installs the
     * launched executable is a shim that exits once it has handed off to the
     * real app, so a dead child mid-poll does not imply a dead instance. Only a
     * dead child that also never served CDP does.
     */
    const exitInfo = capture.readExitInfo();
    kill();
    if (exitInfo) {
      throw new OwnedInstanceExitedError({
        cdpUrl,
        code: exitInfo.code,
        outputTail: capture.readOutput(),
        pid: child.pid,
        signal: exitInfo.signal,
        spawnError: exitInfo.spawnError
      });
    }
    throw error;
  }

  function kill(): void {
    isKillExpected = true;
    clearOwnedInstanceExitMarker(port);
    livenessServer.close();
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
