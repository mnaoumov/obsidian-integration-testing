import process from 'node:process';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ExecResult } from './exec.ts';

import { assertNonNullable } from '../type-guards.ts';
import { exec } from './exec.ts';
import { killProcessTreeByPidAsync } from './kill-process-tree.ts';
import { checkIsProcessAlive } from './process-liveness.ts';

vi.mock('./exec.ts', () => ({ exec: vi.fn() }));
vi.mock('./process-liveness.ts', () => ({ checkIsProcessAlive: vi.fn() }));

const PID = 12_345;
const mockKill = vi.fn<typeof process.kill>();

describe('asynchronous process tree termination', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockKill.mockReturnValue(true);
    vi.spyOn(process, 'kill').mockImplementation(mockKill);
    vi.mocked(checkIsProcessAlive).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('yields while the Windows tree walk is pending and gives it a finite budget', async () => {
    let finish: (() => void) | undefined;
    vi.mocked(exec).mockImplementation(() =>
      new Promise<ExecResult>((resolve) => {
        finish = (): void => {
          resolve({ exitCode: 0, exitSignal: null, stderr: '', stdout: '' });
        };
      })
    );
    let didFinish = false;
    const kill = killProcessTreeByPidAsync(PID).then(() => {
      didFinish = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(didFinish).toBe(false);
    expect(exec).toHaveBeenCalledWith(['taskkill', '/F', '/T', '/PID', String(PID)], {
      isQuiet: true,
      timeoutInMilliseconds: 5000
    });
    assertNonNullable(finish);
    finish();
    await kill;
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('directly terminates a surviving process when the Windows tree walk times out', async () => {
    vi.mocked(exec).mockRejectedValue(new Error('Command timed out after 5000ms'));
    await killProcessTreeByPidAsync(PID);
    expect(mockKill).toHaveBeenCalledWith(PID, 'SIGKILL');
  });

  it('does not directly terminate a process that already exited after a failed tree walk', async () => {
    vi.mocked(exec).mockRejectedValue(new Error('not found'));
    vi.mocked(checkIsProcessAlive).mockReturnValue(false);
    await killProcessTreeByPidAsync(PID);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('uses direct termination on POSIX', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    await killProcessTreeByPidAsync(PID);
    expect(mockKill).toHaveBeenCalledWith(PID, 'SIGKILL');
    expect(exec).not.toHaveBeenCalled();
  });
});
