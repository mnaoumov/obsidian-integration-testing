import type { AddressInfo } from 'node:net';

import {
  connect,
  Server,
  Socket
} from 'node:net';
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ParentLivenessServer } from './parent-liveness.ts';

import {
  buildParentLivenessWatchdogExpression,
  PARENT_LIVENESS_HOST,
  startParentLivenessServer
} from './parent-liveness.ts';

/**
 * The renderer `window` property the watchdog stores its live socket on.
 */
const LIVENESS_FLAG = '__obsidianIntegrationTestingParentLiveness';

/**
 * How many probes the watchdog makes before concluding the harness is gone.
 * Mirrors the limit baked into the expression.
 */
const RECONNECT_ATTEMPT_LIMIT = 3;

/**
 * The delay between probes baked into the expression.
 */
const RECONNECT_DELAY_IN_MILLISECONDS = 250;

/**
 * Port baked into every expression built by these tests. Never connected to for
 * real — the expression is driven against a stubbed `window`.
 */
const STUB_PORT = 51_888;

/**
 * Overrides for {@link createWatchdogWindowStub}.
 */
interface CreateWatchdogWindowStubOptions {
  /**
  Replacement body for `electronWindow.destroy`.
  */
  readonly destroyImpl?: () => void;

  /**
  Makes `require('node:net')` throw, so the bare-`net` fallback is exercised.
  */
  readonly shouldRejectNodePrefix?: boolean;
}

/**
 * A `net.Socket` stand-in that records the listeners the watchdog attaches, so a
 * test can fire them in whatever order it wants to exercise.
 */
interface SocketStub {
  /**
  The events this socket has a listener for, in registration order.
   */
  readonly events: string[];

  /**
   * Invokes the listener the watchdog registered for the event, if any.
   *
   * @param event - The event to fire.
   */
  fire(event: string): void;

  on(event: string, listener: () => void): void;
}

/**
 * The pieces a test needs to drive an armed watchdog: the stubbed `window` the
 * expression runs against, every socket it opened, and the spies its shutdown
 * path calls.
 */
interface WatchdogWindowStub {
  connectSpy: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;

  /**
   * Every socket handed to the watchdog, in the order it asked for them: the
   * armed connection first, then one per reconnect probe.
   */
  readonly sockets: SocketStub[];
  windowClose: ReturnType<typeof vi.fn>;
  windowStub: WindowStub;
}

/**
 * The shape the watchdog expression expects of the renderer's `window`.
 */
type WindowStub = Record<string, unknown>;

describe('startParentLivenessServer', () => {
  it('should listen on a free loopback port', async () => {
    await withLivenessServer(async (server) => {
      expect(server.port).toBeGreaterThan(0);
      const socket = await connectToLivenessServer(server.port);
      expect(socket.remoteAddress).toBe(PARENT_LIVENESS_HOST);
      socket.destroy();
    });
  });

  it('should accept concurrent connections', async () => {
    await withLivenessServer(async (server) => {
      const sockets = await Promise.all([
        connectToLivenessServer(server.port),
        connectToLivenessServer(server.port)
      ]);
      expect(sockets).toHaveLength(2);
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  });

  it('should expose a numeric port through the underlying address info', async () => {
    await withLivenessServer(async (server) => {
      const socket = await connectToLivenessServer(server.port);
      const address = socket.address() as AddressInfo;
      expect(typeof address.port).toBe('number');
      socket.destroy();
    });
  });

  it('should close a live connection when the server closes, which is what the watchdog observes', async () => {
    const server = await startParentLivenessServer();
    const socket = await connectToLivenessServer(server.port);
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
    });

    server.close();
    socket.destroy();

    await expect(closed).resolves.toBeUndefined();
  });

  it('should tolerate a connection reset by the peer', async () => {
    await withLivenessServer(async (server) => {
      const socket = await connectToLivenessServer(server.port);
      socket.resetAndDestroy();

      // A leaked reset would surface as an unhandled 'error' on the server side.
      const next = await connectToLivenessServer(server.port);
      expect(next.readyState).toBe('open');
      next.destroy();
    });
  });

  it('should reject when the port cannot be determined', async () => {
    const addressSpy = vi.spyOn(Server.prototype, 'address').mockReturnValue(null);
    try {
      await expect(startParentLivenessServer()).rejects.toThrow('Failed to determine the parent-liveness port.');
    } finally {
      addressSpy.mockRestore();
    }
  });

  it('should reject when the server fails to listen', async () => {
    const listenSpy = vi.spyOn(Server.prototype, 'listen').mockImplementation(function mockListen(this: Server): Server {
      this.emit('error', new Error('EADDRINUSE'));
      return this;
    });
    try {
      await expect(startParentLivenessServer()).rejects.toThrow('EADDRINUSE');
    } finally {
      listenSpy.mockRestore();
    }
  });
});

describe('buildParentLivenessWatchdogExpression', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should embed the port and the loopback host', () => {
    const expression = buildParentLivenessWatchdogExpression(STUB_PORT);
    expect(expression).toContain(`var PORT = ${String(STUB_PORT)};`);
    expect(expression).toContain(`var HOST = '${PARENT_LIVENESS_HOST}';`);
  });

  it('should stay parseable on an ES5-era engine', () => {
    const expression = buildParentLivenessWatchdogExpression(STUB_PORT);
    expect(expression).not.toContain('=>');
    expect(expression).not.toContain('??');
    expect(expression).not.toContain('?.');
    expect(expression).not.toContain('let ');
    expect(expression).not.toContain('const ');
  });

  it('should report already-armed without opening a second socket', () => {
    const netModule = { connect: vi.fn() };
    const windowStub: WindowStub = {
      __obsidianIntegrationTestingParentLiveness: {},
      require: (): unknown => netModule
    };

    expect(evaluateWatchdog(windowStub)).toBe('already-armed');
    expect(netModule.connect).not.toHaveBeenCalled();
  });

  it('should report unavailable when the renderer has no Node access', () => {
    const windowStub: WindowStub = {
      require: (): never => {
        throw new Error('require is not defined');
      }
    };

    expect(evaluateWatchdog(windowStub)).toBe('unavailable');
  });

  it('should fall back to the bare net specifier', () => {
    const { sockets, windowStub } = createWatchdogWindowStub({ shouldRejectNodePrefix: true });

    expect(evaluateWatchdog(windowStub)).toBe('armed');
    expect(sockets[0]?.events).toStrictEqual(['connect', 'error', 'close']);
  });

  it('should reconnect rather than destroy when the harness is still listening', () => {
    const { connectSpy, destroy, sockets, windowStub } = createWatchdogWindowStub();

    expect(evaluateWatchdog(windowStub)).toBe('armed');
    expect(windowStub[LIVENESS_FLAG]).toBe(sockets[0]);

    sockets[0]?.fire('connect');
    sockets[0]?.fire('close');

    // The close asked a question; the probe answers it.
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();

    sockets[1]?.fire('connect');

    // The probe that answered is the new liveness token.
    expect(windowStub[LIVENESS_FLAG]).toBe(sockets[1]);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('should keep verifying when an adopted socket closes in its turn', () => {
    const { connectSpy, destroy, sockets, windowStub } = createWatchdogWindowStub();

    evaluateWatchdog(windowStub);
    sockets[0]?.fire('connect');
    sockets[0]?.fire('close');
    sockets[1]?.fire('connect');
    sockets[1]?.fire('close');

    expect(connectSpy).toHaveBeenCalledTimes(3);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('should ignore an error on a socket that already answered', () => {
    const { connectSpy, destroy, sockets, windowStub } = createWatchdogWindowStub();

    evaluateWatchdog(windowStub);
    sockets[0]?.fire('connect');
    sockets[0]?.fire('close');
    sockets[1]?.fire('connect');
    sockets[1]?.fire('error');

    // An error after connecting says nothing about the harness — only the close does.
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('should destroy the window once every probe is refused', () => {
    vi.useFakeTimers();
    const { connectSpy, destroy, sockets, windowStub } = createWatchdogWindowStub();

    evaluateWatchdog(windowStub);
    sockets[0]?.fire('connect');
    sockets[0]?.fire('close');
    refuseEveryProbe(sockets);

    expect(connectSpy).toHaveBeenCalledTimes(1 + RECONNECT_ATTEMPT_LIMIT);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('should leave the instance running when the connection never established', () => {
    const { connectSpy, destroy, sockets, windowStub } = createWatchdogWindowStub();

    evaluateWatchdog(windowStub);
    sockets[0]?.fire('error');
    sockets[0]?.fire('close');

    // Fail-open: never having reached the harness is not evidence it died.
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('should fall back to window.close when destroy throws', () => {
    vi.useFakeTimers();
    const { sockets, windowClose, windowStub } = createWatchdogWindowStub({
      destroyImpl: (): never => {
        throw new Error('window already destroyed');
      }
    });

    evaluateWatchdog(windowStub);
    sockets[0]?.fire('connect');
    sockets[0]?.fire('close');
    refuseEveryProbe(sockets);

    expect(windowClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * Opens a client connection to the liveness server and resolves once connected.
 *
 * @param port - The port to connect to.
 * @returns The connected socket.
 */
async function connectToLivenessServer(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(port, PARENT_LIVENESS_HOST);
    socket.once('connect', () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/**
 * Creates a socket stand-in that records the watchdog's listeners and lets a
 * test fire them back.
 *
 * @returns The socket stub.
 */
function createSocketStub(): SocketStub {
  const listeners = new Map<string, () => void>();
  const events: string[] = [];
  return {
    events,
    fire(event: string): void {
      listeners.get(event)?.();
    },
    on(event: string, listener: () => void): void {
      listeners.set(event, listener);
      events.push(event);
    }
  };
}

/**
 * Builds a `window` stub whose `require('node:net')` hands out a fresh recording
 * socket per `connect`, so a test can drive the watchdog's armed connection and
 * each of its reconnect probes independently.
 *
 * @param options - The {@link CreateWatchdogWindowStubOptions}.
 * @returns The stub plus the spies and the sockets it handed out.
 */
function createWatchdogWindowStub(options?: CreateWatchdogWindowStubOptions): WatchdogWindowStub {
  const sockets: SocketStub[] = [];
  const connectSpy = vi.fn((): SocketStub => {
    const socket = createSocketStub();
    sockets.push(socket);
    return socket;
  });
  const destroy = vi.fn(options?.destroyImpl);
  const windowClose = vi.fn();
  const windowStub: WindowStub = {
    close: windowClose,
    electronWindow: { destroy },
    require: (specifier: string): unknown => {
      if (options?.shouldRejectNodePrefix === true && specifier === 'node:net') {
        throw new Error('Cannot find module');
      }
      return { connect: connectSpy };
    }
  };
  return { connectSpy, destroy, sockets, windowClose, windowStub };
}

/**
 * Evaluates the watchdog expression against a stubbed `window`.
 *
 * The expression is authored to run in Obsidian's renderer, where `window` is a
 * global. Compiling it inside a function whose parameter shadows that name is
 * what lets a unit test drive its branches without a live renderer.
 *
 * @param windowStub - The object the expression should see as `window`.
 * @returns The expression's result.
 */
function evaluateWatchdog(windowStub: WindowStub): string {
  /*
   * Compiling a string is the whole point here: this is the exact delivery
   * mechanism the transport uses (`Runtime.evaluate` over CDP), and the string
   * is built by this repo, never taken from input.
   */
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- Evaluating the built expression IS the behavior under test; the source is our own builder.
  const run = new Function('window', `return ${buildParentLivenessWatchdogExpression(STUB_PORT)};`) as (win: WindowStub) => string;
  return run(windowStub);
}

/**
 * Refuses every probe the watchdog makes, draining the retry delay between them,
 * until the attempt budget is spent.
 *
 * Requires fake timers to be installed by the caller.
 *
 * @param sockets - The sockets the watchdog has been handed, appended to as it probes.
 */
function refuseEveryProbe(sockets: SocketStub[]): void {
  for (let attempt = 1; attempt <= RECONNECT_ATTEMPT_LIMIT; attempt++) {
    sockets.at(-1)?.fire('error');
    vi.advanceTimersByTime(RECONNECT_DELAY_IN_MILLISECONDS);
  }
}

/**
 * Runs a callback with a started liveness server, always closing it afterwards.
 *
 * @param callback - Receives the started server.
 */
async function withLivenessServer(callback: (server: ParentLivenessServer) => Promise<void>): Promise<void> {
  const server = await startParentLivenessServer();
  try {
    await callback(server);
  } finally {
    server.close();
  }
}
