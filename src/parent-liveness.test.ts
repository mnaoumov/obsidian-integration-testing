import type { AddressInfo } from 'node:net';

import {
  connect,
  Server,
  Socket
} from 'node:net';
import {
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
}

/**
 * A `net.Socket` stand-in that records the listeners the watchdog attaches, so a
 * test can fire them in whatever order it wants to exercise.
 */
interface SocketStub {
  on(event: string, listener: () => void): void;
}

/**
 * The pieces a test needs to drive an armed watchdog: the stubbed `window` the
 * expression runs against, the listeners it attached, and the spies its
 * shutdown path calls.
 */
interface WatchdogWindowStub {
  destroy: ReturnType<typeof vi.fn>;
  listeners: Map<string, () => void>;
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
  it('should embed the port and the loopback host', () => {
    const expression = buildParentLivenessWatchdogExpression(STUB_PORT);
    expect(expression).toContain(`net.connect(${String(STUB_PORT)}, '${PARENT_LIVENESS_HOST}')`);
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
    const listeners = new Map<string, () => void>();
    const socket = createSocketStub(listeners);
    const windowStub: WindowStub = {
      require: (specifier: string): unknown => {
        if (specifier === 'node:net') {
          throw new Error('Cannot find module');
        }
        return { connect: (): SocketStub => socket };
      }
    };

    expect(evaluateWatchdog(windowStub)).toBe('armed');
    expect([...listeners.keys()]).toStrictEqual(['connect', 'error', 'close']);
  });

  it('should destroy the window once an established connection closes', () => {
    const { destroy, listeners, windowStub } = createWatchdogWindowStub();

    expect(evaluateWatchdog(windowStub)).toBe('armed');
    expect(windowStub['__obsidianIntegrationTestingParentLiveness']).toBeDefined();

    listeners.get('connect')?.();
    listeners.get('close')?.();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('should leave the instance running when the connection never established', () => {
    const { destroy, listeners, windowStub } = createWatchdogWindowStub();

    evaluateWatchdog(windowStub);
    listeners.get('error')?.();
    listeners.get('close')?.();

    expect(destroy).not.toHaveBeenCalled();
  });

  it('should fall back to window.close when destroy throws', () => {
    const { listeners, windowClose, windowStub } = createWatchdogWindowStub({
      destroyImpl: (): never => {
        throw new Error('window already destroyed');
      }
    });

    evaluateWatchdog(windowStub);
    listeners.get('connect')?.();
    listeners.get('close')?.();

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
 * Creates a socket stand-in that records every listener into the given map.
 *
 * @param listeners - The map to record listeners into.
 * @returns The socket stub.
 */
function createSocketStub(listeners: Map<string, () => void>): SocketStub {
  return {
    on(event: string, listener: () => void): void {
      listeners.set(event, listener);
    }
  };
}

/**
 * Builds a `window` stub whose `require('node:net')` yields a socket recording
 * its listeners, so a test can drive the watchdog's handlers directly.
 *
 * @param options - The {@link CreateWatchdogWindowStubOptions}.
 * @returns The stub plus the spies and captured listeners.
 */
function createWatchdogWindowStub(options?: CreateWatchdogWindowStubOptions): WatchdogWindowStub {
  const listeners = new Map<string, () => void>();
  const socket = createSocketStub(listeners);
  const destroy = vi.fn(options?.destroyImpl);
  const windowClose = vi.fn();
  const windowStub: WindowStub = {
    close: windowClose,
    electronWindow: { destroy },
    require: (): unknown => ({ connect: (): SocketStub => socket })
  };
  return { destroy, listeners, windowClose, windowStub };
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
