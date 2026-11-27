import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import process from 'node:process';
import {
  expect,
  it
} from 'vitest';

import { assertNonNullable } from '../type-guards.ts';
import {
  killProcessTree,
  killProcessTreeByPidAsync
} from './kill-process-tree.ts';
import {
  buildHostPortOwnerQuery,
  listPortOwnerPids
} from './port-owner-query.ts';
import { checkIsProcessAlive } from './process-liveness.ts';

it('releases an owned listener while the harness event loop keeps running', async () => {
  const child = spawn(process.execPath, [
    '-e',
    `
    const server = require('node:net').createServer();
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const QUERY_TIMEOUT_IN_MILLISECONDS = 5000;
  const HEARTBEAT_INTERVAL_IN_MILLISECONDS = 1;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => {
        reject(new Error('Listener exited before becoming ready'));
      });
      child.stdout.once('data', (chunk: Buffer) => {
        resolve(Number(chunk.toString().trim()));
      });
    });
    const pid = child.pid;
    assertNonNullable(pid);
    const failures: string[] = [];
    const params = {
      log: (message: string): void => {
        failures.push(message);
      },
      port,
      timeoutInMilliseconds: QUERY_TIMEOUT_IN_MILLISECONDS
    };
    expect(await listPortOwnerPids(params)).toContain(pid);
    let heartbeatCount = 0;
    const heartbeat = setInterval(() => {
      heartbeatCount++;
    }, HEARTBEAT_INTERVAL_IN_MILLISECONDS);
    try {
      await killProcessTreeByPidAsync(pid);
      expect(await listPortOwnerPids(params)).toEqual([]);
      expect(checkIsProcessAlive(pid)).toBe(false);
      expect(heartbeatCount).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    if (child.pid !== undefined && checkIsProcessAlive(child.pid)) {
      killProcessTree(child);
    }
  }
});

// A CDP client (the test runner) holds a socket on the instance's port. Listing it as an owner made the teardown kill its own runner on Linux.
it('lists only the listener, never a client of the port', async () => {
  const QUERY_TIMEOUT_IN_MILLISECONDS = 5000;
  const listener = spawn(process.execPath, [
    '-e',
    `
    const server = require('node:net').createServer();
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const children = [listener];
  const selfSockets: Socket[] = [];
  try {
    const port = Number(await readFirstLine(listener));
    const client = spawn(process.execPath, [
      '-e',
      `
      require('node:net').connect(Number(process.argv[1]), '127.0.0.1', () => console.log('connected'));
      setInterval(() => {}, 1000);
    `,
      String(port)
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(client);
    await readFirstLine(client);
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', resolve);
      socket.once('error', reject);
      selfSockets.push(socket);
    });

    const failures: string[] = [];
    const pids = await listPortOwnerPids({
      log: (message) => {
        failures.push(message);
      },
      port,
      timeoutInMilliseconds: QUERY_TIMEOUT_IN_MILLISECONDS
    });
    expect(failures).toEqual([]);
    expect(pids).toEqual([listener.pid]);
    expect(buildHostPortOwnerQuery(port).command).toBe(process.platform === 'win32' ? 'netstat' : 'lsof');
  } finally {
    for (const socket of selfSockets) {
      socket.destroy();
    }
    for (const child of children) {
      if (child.pid !== undefined && checkIsProcessAlive(child.pid)) {
        killProcessTree(child);
      }
    }
  }
});

async function readFirstLine(child: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => {
      reject(new Error('Child exited before becoming ready'));
    });
    child.stdout?.once('data', (chunk: Buffer) => {
      resolve(chunk.toString().trim());
    });
  });
}
