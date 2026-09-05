import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { checkIsProcessAlive } from './process-liveness.ts';

interface ErrnoError extends Error {
  code: string;
}

const PID = 12_345;

const mockKill = vi.hoisted(() => vi.fn<(pid: number, signal: number) => boolean>());

vi.mock('node:process', () => ({
  default: {
    kill: mockKill
  }
}));

describe('checkIsProcessAlive', () => {
  beforeEach(() => {
    mockKill.mockReset();
    mockKill.mockReturnValue(true);
  });

  it('should probe the process with signal 0', () => {
    expect(checkIsProcessAlive(PID)).toBe(true);
    expect(mockKill).toHaveBeenCalledWith(PID, 0);
  });

  it('should report a process owned by another user as alive', () => {
    mockKill.mockImplementation(() => {
      throw makeErrnoError('EPERM');
    });

    expect(checkIsProcessAlive(PID)).toBe(true);
  });

  it('should report a gone process as not alive', () => {
    mockKill.mockImplementation(() => {
      throw makeErrnoError('ESRCH');
    });

    expect(checkIsProcessAlive(PID)).toBe(false);
  });

  it('should report a probe that fails without an errno code as not alive', () => {
    mockKill.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(checkIsProcessAlive(PID)).toBe(false);
  });
});

function makeErrnoError(code: string): ErrnoError {
  const error = new Error(code) as ErrnoError;
  error.code = code;
  return error;
}
