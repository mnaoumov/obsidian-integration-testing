/**
 * @file
 *
 * Ties a harness-owned Obsidian instance's lifetime to the harness process that
 * launched it, in the one direction the operating system will not do for us.
 *
 * The owned instance is already a child of the harness process, but that link
 * carries no lifetime guarantee. Windows never propagates a parent's death to
 * its children — an orphan simply keeps running with a stale parent id — and on
 * POSIX a `SIGKILL` aimed at a single pid never cascades either. The instance is
 * additionally spawned `detached`, so it is not even in the harness's process
 * group. Teardown therefore relies entirely on the harness running its own
 * cleanup (`killProcessTree` from an `exit`/signal handler), which is exactly
 * what a `SIGKILL`, a Task Manager kill, or an IDE stop button denies it. Every
 * such kill leaks a hidden Obsidian holding a user-data dir and a CDP port, and
 * they accumulate: the next run picks a fresh temp dir and a free port, so
 * nothing collides and nothing complains.
 *
 * The guaranteed fix is an OS primitive — a Windows Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, or `prctl(PR_SET_PDEATHSIG)` on Linux —
 * but neither is reachable from Node without a native addon, which is far too
 * heavy a dependency for this harness.
 *
 * So we use the one cross-platform resource the kernel *does* reclaim
 * deterministically on process death: a socket. The harness listens on a
 * loopback port and the instance's renderer connects to it. However the harness
 * dies — cleanly, `SIGKILL`ed, or crashed — the kernel closes its end, the
 * renderer sees `close`, and the window destroys itself. No polling, no
 * heartbeat interval, no timeout to tune.
 *
 * Deliberately fail-open: the renderer only arms the destroy handler after the
 * connection is actually established. A watchdog that cannot reach the harness
 * leaves the instance running rather than killing a window the developer is
 * working in.
 */

import type { Server } from 'node:net';

import { createServer } from 'node:net';

/**
 * A listening loopback server whose accepted connections act as liveness tokens
 * for the harness process.
 */
export interface ParentLivenessServer {
  /** Stops listening and drops every accepted connection. */
  close(): void;

  /** The loopback port the renderer watchdog should connect back to. */
  readonly port: number;
}

/**
 * Loopback host the liveness server binds to. Never exposed off-machine.
 */
export const PARENT_LIVENESS_HOST = '127.0.0.1';

/**
 * Builds the expression evaluated in the owned instance's renderer to arm the
 * watchdog.
 *
 * Written in ES5 style (`var`, `function`) with no optional chaining, matching
 * {@link DISMISS_TRUST_DIALOG_EXPR}: the same expression has to parse on the
 * Chromium 80-era renderers of the oldest supported Obsidian versions (L26).
 *
 * Arming is idempotent — a second evaluation finds the stored socket and
 * returns without opening another connection, so a retried readiness pass does
 * not pile up sockets.
 *
 * @param port - The loopback port returned by {@link startParentLivenessServer}.
 * @returns The expression to evaluate, yielding `'armed'`, `'already-armed'`, or `'unavailable'`.
 */
export function buildParentLivenessWatchdogExpr(port: number): string {
  return `(function() {
  var FLAG = '__obsidianIntegrationTestingParentLiveness';
  if (window[FLAG]) { return 'already-armed'; }
  var net;
  try {
    net = window.require('node:net');
  } catch (nodePrefixError) {
    try {
      net = window.require('net');
    } catch (barePrefixError) {
      return 'unavailable';
    }
  }
  var socket = net.connect(${String(port)}, '${PARENT_LIVENESS_HOST}');
  window[FLAG] = socket;
  var isConnected = false;
  socket.on('connect', function() { isConnected = true; });
  socket.on('error', function() { /* Handled by the close listener below. */ });
  socket.on('close', function() {
    if (!isConnected) { return; }
    try {
      window.electronWindow.destroy();
    } catch (destroyError) {
      window.close();
    }
  });
  return 'armed';
})()`;
}

/**
 * Starts the loopback liveness server the owned instance's renderer connects
 * back to.
 *
 * The server and every accepted socket are `unref`ed, so holding a watchdog
 * connection open never keeps the harness process alive on its own — the
 * connection is a token the kernel reclaims, not work to wait on.
 *
 * @returns A {@link Promise} resolving to the listening {@link ParentLivenessServer}.
 */
export async function startParentLivenessServer(): Promise<ParentLivenessServer> {
  const server = createServer((socket) => {
    socket.unref();
    // The connection carries no data — it exists only so its close is observable.
    socket.on('error', () => {
      // A renderer torn down mid-connection resets rather than closes; not an error here.
    });
  });
  server.unref();

  const port = await listenOnFreeLoopbackPort(server);
  return {
    close(): void {
      server.close();
    },
    port
  };
}

/**
 * Binds the server to an ephemeral loopback port and reports which one it got.
 *
 * @param server - The server to bind.
 * @returns A {@link Promise} resolving to the assigned port.
 * @throws If the server reports an error before listening, or binds to a pipe rather than a port.
 */
async function listenOnFreeLoopbackPort(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, PARENT_LIVENESS_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to determine the parent-liveness port.'));
        return;
      }
      resolve(address.port);
    });
  });
}
