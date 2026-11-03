import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  listPortOwnerPids,
  listPortOwnerPidsSync
} from '../../process/port-owner-query.ts';
import { checkIsProcessAlive } from '../../process/process-liveness.ts';
import {
  listOwnedInstancePortOwnerPids,
  listOwnedInstancePortOwnerPidsAsync
} from './obsidian-instance.ts';

vi.mock('../../process/port-owner-query.ts', () => ({
  listPortOwnerPids: vi.fn(),
  listPortOwnerPidsSync: vi.fn()
}));
vi.mock('../../process/process-liveness.ts', () => ({ checkIsProcessAlive: vi.fn() }));

const PORT = 12_345;
const EXITED_PID = 123;
const LIVE_PID = 456;

describe('owned CDP listener snapshots', () => {
  it('discards an exited PID before synchronous cleanup can treat it as a survivor', () => {
    vi.mocked(listPortOwnerPidsSync).mockReturnValue([EXITED_PID, LIVE_PID]);
    vi.mocked(checkIsProcessAlive).mockImplementation((pid) => pid === LIVE_PID);
    expect(listOwnedInstancePortOwnerPids(PORT)).toEqual([LIVE_PID]);
  });

  it('discards a PID that exits while an asynchronous listener query is running', async () => {
    vi.mocked(listPortOwnerPids).mockImplementation(() => {
      vi.mocked(checkIsProcessAlive).mockImplementation((pid) => pid === LIVE_PID);
      return Promise.resolve([EXITED_PID, LIVE_PID]);
    });
    vi.mocked(checkIsProcessAlive).mockReturnValue(true);
    expect(await listOwnedInstancePortOwnerPidsAsync(PORT)).toEqual([LIVE_PID]);
  });
});
