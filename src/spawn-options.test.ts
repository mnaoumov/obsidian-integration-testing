import {
  describe,
  expect,
  it
} from 'vitest';

import {
  resolveAppiumSpawnFlags,
  resolveEmulatorSpawnFlags
} from './spawn-options.ts';

describe('resolveAppiumSpawnFlags', () => {
  it('should not detach when the console is hidden, so windowsHide is honored', () => {
    // `detached: true` silently defeats `windowsHide` on Windows (a new console window appears anyway), so the hidden path must NOT detach.
    expect(resolveAppiumSpawnFlags(true)).toStrictEqual({ detached: false, windowsHide: true });
  });

  it('should detach when the console is visible, giving it its own window', () => {
    expect(resolveAppiumSpawnFlags(false)).toStrictEqual({ detached: true, windowsHide: false });
  });
});

describe('resolveEmulatorSpawnFlags', () => {
  it('should never detach and hide the console when the emulator is hidden', () => {
    // The emulator spawns console-app grandchildren (netsim/qemu); when it is detached (no console) they each allocate their own VISIBLE console, so not detaching lets them inherit the emulator's hidden console instead.
    expect(resolveEmulatorSpawnFlags(true)).toStrictEqual({ detached: false, windowsHide: true });
  });

  it('should never detach and not hide the console when the emulator is visible', () => {
    expect(resolveEmulatorSpawnFlags(false)).toStrictEqual({ detached: false, windowsHide: false });
  });
});
