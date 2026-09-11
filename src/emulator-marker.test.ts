import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { EmulatorMarker } from './emulator-marker.ts';

import {
  clearEmulatorMarker,
  clearEmulatorMarkerIfStopped,
  listEmulatorMarkers,
  readEmulatorMarker,
  resolveEmulatorMarkerVerdict,
  selectLiveMarkedPids,
  writeEmulatorMarker
} from './emulator-marker.ts';

const AVD_NAME = 'obsidian_test';
const MARKER_DIR = join('/tmp', 'obsidian-integration-testing');
const MARKER_PATH = join(MARKER_DIR, 'obsidian_test.emulator.json');
const NOW_IN_MILLISECONDS = 1_700_000_000_000;
const EARLIER_IN_MILLISECONDS = 1_699_999_000_000;
const CURRENT_PID = vi.hoisted(() => 4242);
const OTHER_PID = 5151;
const LAUNCHER_PID = 100;
const BACKEND_PID = 101;

const MARKER: EmulatorMarker = {
  avdName: AVD_NAME,
  deviceId: 'emulator-5554',
  ownedEmulatorPids: [LAUNCHER_PID, BACKEND_PID],
  ownerPid: OTHER_PID,
  startedAtInMilliseconds: EARLIER_IN_MILLISECONDS
};

const mockMkdirSync = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => void>());
const mockReaddirSync = vi.hoisted(() => vi.fn<(path: string) => string[]>());
const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());
const mockRmSync = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => void>());
const mockWriteFileSync = vi.hoisted(() => vi.fn<(path: string, content: string) => void>());

vi.mock('node:fs', () => ({
  mkdirSync: mockMkdirSync,
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  rmSync: mockRmSync,
  writeFileSync: mockWriteFileSync
}));

vi.mock('node:os', () => ({
  tmpdir: (): string => '/tmp'
}));

const mockKill = vi.hoisted(() => vi.fn<(pid: number, signal: number) => void>());

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return {
    ...actual,
    default: {
      ...actual,
      kill: mockKill,
      pid: CURRENT_PID
    }
  };
});

const mockLog = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock('./log.ts', () => ({
  log: mockLog
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_IN_MILLISECONDS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('writeEmulatorMarker', () => {
  it('should record the emulator as owned by the current process, started now', () => {
    writeEmulatorMarker({ avdName: AVD_NAME, deviceId: 'emulator-5554', ownedEmulatorPids: [LAUNCHER_PID, BACKEND_PID] });

    expect(mockMkdirSync).toHaveBeenCalledWith(MARKER_DIR, { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      MARKER_PATH,
      JSON.stringify({
        avdName: AVD_NAME,
        deviceId: 'emulator-5554',
        ownedEmulatorPids: [LAUNCHER_PID, BACKEND_PID],
        ownerPid: CURRENT_PID,
        startedAtInMilliseconds: NOW_IN_MILLISECONDS
      })
    );
  });

  it('should keep the original start time on a takeover', () => {
    writeEmulatorMarker({
      avdName: AVD_NAME,
      deviceId: 'emulator-5554',
      ownedEmulatorPids: [BACKEND_PID],
      startedAtInMilliseconds: EARLIER_IN_MILLISECONDS
    });

    const [, content] = mockWriteFileSync.mock.calls[0] ?? [];
    expect(JSON.parse(content ?? '')).toMatchObject({ ownerPid: CURRENT_PID, startedAtInMilliseconds: EARLIER_IN_MILLISECONDS });
  });

  it('should log rather than throw when the marker cannot be written', () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(() => {
      writeEmulatorMarker({ avdName: AVD_NAME, deviceId: 'emulator-5554', ownedEmulatorPids: [BACKEND_PID] });
    }).not.toThrow();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Could not record the emulator for AVD "obsidian_test": EACCES'));
  });

  it('should log a non-error failure', () => {
    mockWriteFileSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Deliberately not an Error: this is the `String(error)` fallback under test.
      throw 'disk full';
    });

    writeEmulatorMarker({ avdName: AVD_NAME, deviceId: 'emulator-5554', ownedEmulatorPids: [BACKEND_PID] });

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});

describe('readEmulatorMarker', () => {
  it('should read back a marker written for the same AVD', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MARKER));

    expect(readEmulatorMarker(AVD_NAME)).toStrictEqual(MARKER);
    expect(mockReadFileSync).toHaveBeenCalledWith(MARKER_PATH, 'utf-8');
  });

  it('should return undefined when there is no marker', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(readEmulatorMarker(AVD_NAME)).toBeUndefined();
  });

  it('should return undefined for a malformed marker', () => {
    mockReadFileSync.mockReturnValue('{not json');

    expect(readEmulatorMarker(AVD_NAME)).toBeUndefined();
  });

  it('should return undefined for a non-object marker', () => {
    mockReadFileSync.mockReturnValue('null');

    expect(readEmulatorMarker(AVD_NAME)).toBeUndefined();
  });

  it('should return undefined when the marker describes another AVD', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ ...MARKER, avdName: 'obsidian_screenshots' }));

    expect(readEmulatorMarker(AVD_NAME)).toBeUndefined();
  });

  it.each([
    ['deviceId', { deviceId: 5554 }],
    ['ownerPid', { ownerPid: '5151' }],
    ['startedAtInMilliseconds', { startedAtInMilliseconds: 'yesterday' }],
    ['ownedEmulatorPids (not an array)', { ownedEmulatorPids: 101 }],
    ['ownedEmulatorPids (a non-number entry)', { ownedEmulatorPids: [100, '101'] }]
  ])('should return undefined when %s has the wrong type', (_field, override) => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ ...MARKER, ...override }));

    expect(readEmulatorMarker(AVD_NAME)).toBeUndefined();
  });
});

describe('listEmulatorMarkers', () => {
  it('should read every emulator marker and skip other files and unreadable markers', () => {
    mockReaddirSync.mockReturnValue(['4723.appium-server.json', 'obsidian_test.emulator.json', 'broken.emulator.json', 'android.setup.lock']);
    mockReadFileSync.mockImplementation((path) => {
      if (path === MARKER_PATH) {
        return JSON.stringify(MARKER);
      }
      return '{not json';
    });

    expect(listEmulatorMarkers()).toStrictEqual([MARKER]);
  });

  it('should return nothing when the marker directory cannot be read', () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(listEmulatorMarkers()).toStrictEqual([]);
  });
});

describe('clearEmulatorMarker', () => {
  it('should remove the marker file', () => {
    clearEmulatorMarker(AVD_NAME);

    expect(mockRmSync).toHaveBeenCalledWith(MARKER_PATH, { force: true });
  });

  it('should log rather than throw when the marker cannot be removed', () => {
    mockRmSync.mockImplementation(() => {
      throw new Error('EBUSY');
    });

    expect(() => {
      clearEmulatorMarker(AVD_NAME);
    }).not.toThrow();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Could not remove the marker for AVD "obsidian_test": EBUSY'));
  });
});

describe('clearEmulatorMarkerIfStopped', () => {
  it('should remove the marker once none of its processes is running', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MARKER));
    mockKill.mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    clearEmulatorMarkerIfStopped(AVD_NAME);

    expect(mockRmSync).toHaveBeenCalledWith(MARKER_PATH, { force: true });
  });

  it('should remove an unreadable marker', () => {
    mockReadFileSync.mockReturnValue('{not json');

    clearEmulatorMarkerIfStopped(AVD_NAME);

    expect(mockRmSync).toHaveBeenCalledWith(MARKER_PATH, { force: true });
  });

  /*
   * A stop is verified against the PIDs it owned. A launch that died at once owns
   * none and verifies trivially — it must not erase the record of an emulator
   * that is still running.
   */
  it('should keep the marker while one of its processes is still running', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(MARKER));
    mockKill.mockImplementation((pid) => {
      if (pid !== BACKEND_PID) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
    });

    clearEmulatorMarkerIfStopped(AVD_NAME);

    expect(mockRmSync).not.toHaveBeenCalled();
  });
});

describe('selectLiveMarkedPids', () => {
  it('should keep only the marked PIDs that are live emulator processes, in marker order', () => {
    expect(selectLiveMarkedPids(MARKER, [BACKEND_PID, 999, LAUNCHER_PID])).toStrictEqual([LAUNCHER_PID, BACKEND_PID]);
    expect(selectLiveMarkedPids(MARKER, [BACKEND_PID])).toStrictEqual([BACKEND_PID]);
    expect(selectLiveMarkedPids(MARKER, [999])).toStrictEqual([]);
  });
});

describe('resolveEmulatorMarkerVerdict', () => {
  /*
   * The case that filled the drive: a worker started the emulator and died, so
   * its owner is gone while the backend it forked is still running.
   */
  it('should convict a live emulator whose owner is gone as a harness leftover', () => {
    expect(resolveEmulatorMarkerVerdict({ currentPid: CURRENT_PID, isOwnerAlive: false, liveEmulatorPids: [BACKEND_PID], marker: MARKER }))
      .toBe('harness-leftover');
  });

  it('should treat the caller\'s own emulator as a leftover it may stop', () => {
    expect(
      resolveEmulatorMarkerVerdict({
        currentPid: CURRENT_PID,
        isOwnerAlive: true,
        liveEmulatorPids: [BACKEND_PID],
        marker: { ...MARKER, ownerPid: CURRENT_PID }
      })
    ).toBe('harness-leftover');
  });

  it('should leave an emulator another live harness process owns to that process', () => {
    expect(resolveEmulatorMarkerVerdict({ currentPid: CURRENT_PID, isOwnerAlive: true, liveEmulatorPids: [BACKEND_PID], marker: MARKER }))
      .toBe('in-use-by-live-run');
  });

  /*
   * Evidence before ownership: a recycled PID is not an emulator, so a marker
   * whose PIDs are all gone from the emulator listing proves nothing, even when
   * its owner looks alive.
   */
  it('should call a marker stale when none of its PIDs is a live emulator, whoever owns it', () => {
    for (const isOwnerAlive of [false, true]) {
      expect(resolveEmulatorMarkerVerdict({ currentPid: CURRENT_PID, isOwnerAlive, liveEmulatorPids: [999], marker: MARKER }))
        .toBe('stale-marker');
    }
  });
});
