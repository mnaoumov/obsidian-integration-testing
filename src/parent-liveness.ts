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
 * dies — cleanly, `SIGKILL`ed, or crashed — the kernel closes its end and the
 * renderer sees `close`. No polling, no heartbeat interval, no timeout to tune.
 *
 * **A close is a question, not a verdict.** A socket closing is not the same
 * event as a process dying, and treating them as identical destroyed healthy
 * instances: measured on 2026-09-05, a renderer's idle liveness socket sent
 * `FIN` on its own — 3 min 13 s into one run, 11 min 56 s into another — while
 * the harness was still listening and went on working for another 14 minutes.
 * Every test file scheduled after the death then failed in tens of milliseconds
 * with `ECONNREFUSED` on the dead CDP port; the worst run reported 156 such
 * failures across 21 files, not one of them a test result. Why an idle unref'd
 * loopback socket in an Electron renderer does that is not established, and does
 * not need to be: the lifetimes vary run to run, so no fixed timeout explains it.
 *
 * So the `close` handler **verifies before destroying**: it reconnects to the
 * same loopback port. A harness that is alive is still listening, so the
 * reconnect succeeds and the new socket becomes the liveness token; only when
 * nothing answers after a few tries — what a dead harness actually looks like —
 * is the window destroyed. The leak the watchdog exists to prevent is still
 * prevented, and the measured recovery is 11 ms.
 *
 * A reconnect rather than a check on the harness's process id, because it proves
 * the thing the watchdog actually depends on — the liveness server still serving
 * — and it stays correct against a *busy* harness: the kernel completes a
 * loopback handshake out of the listen backlog even while Node's event loop is
 * blocked. Its one residual ambiguity is accepted: a reconnect proves *something*
 * is listening on that ephemeral port, not that it is ours. The probe follows the
 * close by milliseconds, so another process winning that exact port in between is
 * not a risk worth a handshake protocol.
 *
 * Deliberately fail-open: the renderer only arms the destroy path after the
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
  /**
   * Stops listening.
   *
   * Node keeps already-accepted connections alive across a `close()`, so this
   * does not by itself signal the renderer — the kernel reclaiming the socket on
   * process death is what does. What it does guarantee is that a watchdog probe
   * arriving afterwards is refused, which is the answer a torn-down harness
   * should give.
   */
  close(): void;

  /**
  The loopback port the renderer watchdog should connect back to.
   */
  readonly port: number;
}

/**
 * Loopback host the liveness server binds to. Never exposed off-machine.
 */
export const PARENT_LIVENESS_HOST = '127.0.0.1';

/**
 * How many times the watchdog probes the loopback port before concluding the
 * harness is gone.
 *
 * More than one, so a single transient refusal cannot cost a whole run; small,
 * because every attempt is a loopback connect that either completes or is
 * refused immediately, and an instance whose harness really did die should not
 * linger.
 */
const RECONNECT_ATTEMPT_LIMIT = 3;

/**
 * How long the watchdog waits between probes.
 *
 * Long enough to outlast a momentary refusal, short enough that exhausting the
 * whole budget still destroys an orphaned window inside a second.
 */
const RECONNECT_DELAY_IN_MILLISECONDS = 250;

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
export function buildParentLivenessWatchdogExpression(port: number): string {
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
  var PORT = ${String(port)};
  var HOST = '${PARENT_LIVENESS_HOST}';
  var RECONNECT_ATTEMPT_LIMIT = ${String(RECONNECT_ATTEMPT_LIMIT)};
  var RECONNECT_DELAY_IN_MILLISECONDS = ${String(RECONNECT_DELAY_IN_MILLISECONDS)};
  var socket = net.connect(PORT, HOST);
  window[FLAG] = socket;
  var isConnected = false;
  socket.on('connect', function() { isConnected = true; });
  socket.on('error', function() { /* The close handler below decides what an error meant. */ });
  socket.on('close', function() {
    /* Fail open: a connection that never established is no evidence the harness died. */
    if (!isConnected) { return; }
    reconnect(1);
  });
  return 'armed';

  /* A close only asks the question. Reconnecting answers it. */
  function reconnect(attempt) {
    var didConnect = false;
    var probe = net.connect(PORT, HOST);
    probe.on('connect', function() {
      /* Someone is still listening, so the harness is alive. This is the new token. */
      didConnect = true;
      window[FLAG] = probe;
      probe.on('close', function() { reconnect(1); });
    });
    probe.on('error', function() {
      /*
       * This handler outlives the connect, so it doubles as the adopted socket's
       * error handler. Once connected, an error says nothing about the harness —
       * the close that follows it re-runs the probe.
       */
      if (didConnect) { return; }
      if (attempt < RECONNECT_ATTEMPT_LIMIT) {
        setTimeout(function() { reconnect(attempt + 1); }, RECONNECT_DELAY_IN_MILLISECONDS);
        return;
      }
      /* Nothing answered after several tries: the harness really is gone. */
      destroyWindow();
    });
  }

  function destroyWindow() {
    try {
      window.electronWindow.destroy();
    } catch (destroyError) {
      window.close();
    }
  }
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
