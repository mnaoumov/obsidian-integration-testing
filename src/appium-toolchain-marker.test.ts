import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  APPIUM_TOOLCHAIN_MARKER_MAX_AGE_IN_MILLISECONDS,
  checkIsAppiumToolchainMarkerFresh,
  clearAppiumToolchainMarker,
  describeProbeDuration,
  readAppiumToolchainMarker,
  writeAppiumToolchainMarker
} from './appium-toolchain-marker.ts';

const MARKER_DIR = join('/tmp', 'obsidian-integration-testing');
const MARKER_PATH = join(MARKER_DIR, 'appium-toolchain.json');
const NOW_IN_MILLISECONDS = 1_700_000_000_000;
const DRIVER_NAME = 'uiautomator2';

const mockMkdirSync = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => void>());
const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());
const mockRmSync = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => void>());
const mockWriteFileSync = vi.hoisted(() => vi.fn<(path: string, content: string) => void>());
const mockLog = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock('node:fs', () => ({
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  rmSync: mockRmSync,
  writeFileSync: mockWriteFileSync
}));

vi.mock('node:os', () => ({
  tmpdir: (): string => '/tmp'
}));

vi.mock('./log.ts', () => ({
  log: mockLog
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_IN_MILLISECONDS);
  mockMkdirSync.mockReset();
  mockReadFileSync.mockReset();
  mockRmSync.mockReset();
  mockWriteFileSync.mockReset();
  mockLog.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('checkIsAppiumToolchainMarkerFresh', () => {
  const marker = { appiumVersion: '3.7.0', checkedAtInMilliseconds: NOW_IN_MILLISECONDS - 1000, driverName: DRIVER_NAME };

  it('should trust a recent marker for the same driver', () => {
    expect(checkIsAppiumToolchainMarkerFresh({ driverName: DRIVER_NAME, marker, nowInMilliseconds: NOW_IN_MILLISECONDS })).toBe(true);
  });

  it('should not trust a missing marker', () => {
    expect(checkIsAppiumToolchainMarkerFresh({ driverName: DRIVER_NAME, marker: undefined, nowInMilliseconds: NOW_IN_MILLISECONDS })).toBe(false);
  });

  it('should not trust a marker for another driver', () => {
    expect(checkIsAppiumToolchainMarkerFresh({ driverName: 'espresso', marker, nowInMilliseconds: NOW_IN_MILLISECONDS })).toBe(false);
  });

  it('should not trust a marker at or past its maximum age', () => {
    expect(checkIsAppiumToolchainMarkerFresh({
      driverName: DRIVER_NAME,
      marker,
      nowInMilliseconds: marker.checkedAtInMilliseconds + APPIUM_TOOLCHAIN_MARKER_MAX_AGE_IN_MILLISECONDS
    })).toBe(false);
  });

  it('should not trust a marker from the future', () => {
    expect(checkIsAppiumToolchainMarkerFresh({ driverName: DRIVER_NAME, marker, nowInMilliseconds: marker.checkedAtInMilliseconds - 1 })).toBe(false);
  });
});

describe('readAppiumToolchainMarker', () => {
  it('should read a well-formed marker', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ appiumVersion: '3.7.0', checkedAtInMilliseconds: 5, driverName: DRIVER_NAME }));
    expect(readAppiumToolchainMarker()).toEqual({ appiumVersion: '3.7.0', checkedAtInMilliseconds: 5, driverName: DRIVER_NAME });
    expect(mockReadFileSync).toHaveBeenCalledWith(MARKER_PATH, 'utf-8');
  });

  it('should read a missing marker as none', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readAppiumToolchainMarker()).toBeUndefined();
  });

  it('should read malformed JSON as none', () => {
    mockReadFileSync.mockReturnValue('{');
    expect(readAppiumToolchainMarker()).toBeUndefined();
  });

  it('should read a non-object as none', () => {
    mockReadFileSync.mockReturnValue('null');
    expect(readAppiumToolchainMarker()).toBeUndefined();
  });

  it('should read a marker with a mistyped field as none', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ appiumVersion: '3.7.0', checkedAtInMilliseconds: '5', driverName: DRIVER_NAME }));
    expect(readAppiumToolchainMarker()).toBeUndefined();
  });
});

describe('writeAppiumToolchainMarker', () => {
  it('should stamp the marker with the current time', () => {
    writeAppiumToolchainMarker({ appiumVersion: '3.7.0', driverName: DRIVER_NAME });
    expect(mockMkdirSync).toHaveBeenCalledWith(MARKER_DIR, { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      MARKER_PATH,
      JSON.stringify({ appiumVersion: '3.7.0', checkedAtInMilliseconds: NOW_IN_MILLISECONDS, driverName: DRIVER_NAME })
    );
  });

  it('should log rather than throw when the write fails', () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => {
      writeAppiumToolchainMarker({ appiumVersion: '3.7.0', driverName: DRIVER_NAME });
    }).not.toThrow();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});

describe('clearAppiumToolchainMarker', () => {
  it('should remove the marker', () => {
    clearAppiumToolchainMarker();
    expect(mockRmSync).toHaveBeenCalledWith(MARKER_PATH, { force: true });
  });

  it('should log rather than throw when the removal fails', () => {
    mockRmSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- A non-Error throw is the branch this case covers.
      throw 'EBUSY';
    });
    expect(() => {
      clearAppiumToolchainMarker();
    }).not.toThrow();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('EBUSY'));
  });
});

describe('describeProbeDuration', () => {
  it('should state a quick probe plainly', () => {
    expect(describeProbeDuration(1500)).toBe('the probe took 1.5s');
  });

  it('should name host contention for a slow probe', () => {
    expect(describeProbeDuration(245_000)).toContain('245.0s against 1.5-3s on an idle host');
  });
});
