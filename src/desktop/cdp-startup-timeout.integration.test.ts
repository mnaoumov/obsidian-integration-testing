import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  existsSync,
  mkdtempSync,
  rmSync
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  expect,
  it,
  vi
} from 'vitest';

import {
  noop,
  noopAsync
} from '../noop.ts';
import { ensureNonNullable } from '../type-guards.ts';
import { connectToCdp } from './connect-to-cdp.ts';
import {
  launchOwnedObsidianInstance,
  listOwnedInstancePortOwnerPidsAsync
} from './owned-instance/obsidian-instance.ts';
import { DesktopCdpTransport } from './transport-desktop-cdp.ts';

const COMMAND_TIMEOUT_IN_MILLISECONDS = 300;
const FAILURE_BOUND_IN_MILLISECONDS = 3000;

interface StartupCommand {
  readonly id: number;
  readonly params: StartupCommandParams;
}

interface StartupCommandParams {
  readonly expression: string;
}

vi.mock('./owned-instance/obsidian-instance.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./owned-instance/obsidian-instance.ts')>(),
  launchOwnedObsidianInstance: vi.fn(),
  listOwnedInstancePortOwnerPidsAsync: vi.fn()
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('caps nested startup commands by the readiness budget even with a longer command timeout', async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), 'cdp-readiness-'));
  const vaultPath = join(userDataDirectory, 'vault');
  let isServing = false;
  class StartupWebSocket extends EventTarget {
    public static readonly OPEN = 1;
    public readyState = 1;

    public constructor() {
      super();
      setTimeout(() => this.dispatchEvent(new Event('open')), 0);
    }

    public close(): void {
      this.readyState = 3;
    }

    public send(data: string): void {
      const command = JSON.parse(data) as StartupCommand;
      if (command.params.expression.includes('app.vault.adapter')) {
        setTimeout(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ id: command.id, result: { result: { type: 'string', value: vaultPath } } })
            })
          ), 0);
      }
      // The target has a vault, but the namespace/layout commands never answer.
    }
  }
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', StartupWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      return isServing ? Promise.resolve(Response.json([{ id: 'startup', type: 'page', webSocketDebuggerUrl: 'ws://unused' }])) : Promise.reject(new Error('Endpoint closed'));
    })
  );
  const launch = vi.mocked(launchOwnedObsidianInstance).mockImplementation(() => {
    isServing = true;
    return Promise.resolve({
      cdpUrl: 'http://127.0.0.1:1',
      expectExit: noop,
      kill: noop,
      killAsync: async () => {
        isServing = false;
        await noopAsync();
      },
      parentLivenessPort: 2,
      port: 1,
      readExitInfo: vi.fn(),
      readOutput: () => ''
    });
  });
  vi.mocked(listOwnedInstancePortOwnerPidsAsync).mockResolvedValue([]);
  const transport = new DesktopCdpTransport({ commandTimeoutInMilliseconds: 300_000, ownedInstance: { exePath: 'unused', userDataDirectory } });
  let failure: unknown;
  const registration = transport.registerVault(vaultPath).catch((error: unknown) => {
    failure = error;
  });
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('did not become ready within 30000ms');
    expect(launch).toHaveBeenCalledTimes(3);
    await registration;
  } finally {
    await transport.dispose();
    rmSync(userDataDirectory, { force: true, recursive: true });
  }
});

it.each(['headers', 'body', 'websocket'])('bounds a stalled CDP %s operation and releases its socket', async (phase) => {
  const sockets = new Set<Socket>();
  let stalledSocket: Duplex | undefined;
  let port = 0;
  const server = createServer((request, response) => {
    if (phase !== 'websocket') {
      stalledSocket = request.socket;
    }
    if (phase === 'body') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('[');
    } else if (phase === 'websocket') {
      response.end(JSON.stringify([{ id: 'stalled', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/stalled` }]));
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', noop);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_request, socket) => {
    stalledSocket = socket;
    socket.resume();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = ensureNonNullable(server.address());
  if (typeof address === 'string') {
    throw new TypeError('Expected a TCP listener');
  }
  port = address.port;
  const transport = new DesktopCdpTransport({ cdpHost: '127.0.0.1', cdpPort: port, commandTimeoutInMilliseconds: COMMAND_TIMEOUT_IN_MILLISECONDS });
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks++;
  }, 10);
  try {
    const started = performance.now();
    await expect(transport.evaluate('1', { cwd: 'stalled-vault' })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(FAILURE_BOUND_IN_MILLISECONDS);
    expect(ticks).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(ensureNonNullable(stalledSocket).destroyed).toBe(true);
    });
  } finally {
    clearInterval(heartbeat);
    await transport.dispose();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
});

it('disposes the owned transport and temporary vault when connection setup fails', async () => {
  const failure = new Error('Readiness failed');
  let vaultPath: string | undefined;
  vi.spyOn(DesktopCdpTransport.prototype, 'registerVault').mockImplementationOnce((path) => {
    vaultPath = path;
    return Promise.reject(failure);
  });
  const dispose = vi.spyOn(DesktopCdpTransport.prototype, 'dispose');
  await expect(connectToCdp()).rejects.toBe(failure);
  expect(dispose).toHaveBeenCalledOnce();
  expect(existsSync(ensureNonNullable(vaultPath))).toBe(false);
});
