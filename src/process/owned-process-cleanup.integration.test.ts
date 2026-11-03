import { spawn } from 'node:child_process';
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
import { listPortOwnerPids } from './port-owner-query.ts';
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
