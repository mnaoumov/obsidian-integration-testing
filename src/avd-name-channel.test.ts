import {
  describe,
  expect,
  it
} from 'vitest';

import type { AvdNameChannel } from './avd-name-channel.ts';

import {
  buildAvdNameChannelArguments,
  buildAvdNameChannelCommand,
  describeAdbCommand,
  FIRST_AVD_NAME_CHANNEL,
  parseAvdNameAnswer,
  resolveNextAvdNameChannel
} from './avd-name-channel.ts';
import { castTo } from './type-guards.ts';

const DEVICE_ID = 'emulator-5554';

describe('FIRST_AVD_NAME_CHANNEL', () => {
  it('should start on the guest property, which travels the channel the run needs anyway', () => {
    expect(FIRST_AVD_NAME_CHANNEL).toBe('getprop-boot');
  });
});

describe('buildAvdNameChannelArguments', () => {
  it('should read the modern property over adbd', () => {
    expect(buildAvdNameChannelArguments({ channel: 'getprop-boot', deviceId: DEVICE_ID })).toStrictEqual([
      '-s',
      DEVICE_ID,
      'shell',
      'getprop',
      'ro.boot.qemu.avd_name'
    ]);
  });

  it('should read the older property over adbd', () => {
    expect(buildAvdNameChannelArguments({ channel: 'getprop-kernel', deviceId: DEVICE_ID })).toStrictEqual([
      '-s',
      DEVICE_ID,
      'shell',
      'getprop',
      'ro.kernel.qemu.avd_name'
    ]);
  });

  it('should fall back to the emulator console', () => {
    expect(buildAvdNameChannelArguments({ channel: 'console', deviceId: DEVICE_ID })).toStrictEqual([
      '-s',
      DEVICE_ID,
      'emu',
      'avd',
      'name'
    ]);
  });

  it('should address a placeholder as written, so a message about several devices quotes one command', () => {
    expect(buildAvdNameChannelArguments({ channel: 'console', deviceId: '<device>' })).toContain('<device>');
  });
});

describe('buildAvdNameChannelCommand', () => {
  it('should leave the device selection to the caller that prepends it', () => {
    expect(buildAvdNameChannelCommand('getprop-boot')).toStrictEqual(['shell', 'getprop', 'ro.boot.qemu.avd_name']);
    expect(buildAvdNameChannelCommand('console')).toStrictEqual(['emu', 'avd', 'name']);
  });
});

describe('describeAdbCommand', () => {
  it('should render the arguments the run actually passes', () => {
    const commandArguments = buildAvdNameChannelArguments({ channel: 'getprop-boot', deviceId: DEVICE_ID });

    expect(describeAdbCommand(commandArguments)).toBe('adb -s emulator-5554 shell getprop ro.boot.qemu.avd_name');
  });
});

describe('parseAvdNameAnswer', () => {
  it('should take the console answer, which is followed by its OK line', () => {
    expect(parseAvdNameAnswer('obsidian_test\nOK\n')).toBe('obsidian_test');
  });

  it('should take a property answer, which has no second line', () => {
    expect(parseAvdNameAnswer('obsidian_test\n')).toBe('obsidian_test');
  });

  it('should read an unterminated answer, which carries no line break at all', () => {
    expect(parseAvdNameAnswer('obsidian_test')).toBe('obsidian_test');
  });

  it('should report nothing for an unset property, whose line is empty', () => {
    expect(parseAvdNameAnswer('\n')).toBe('');
  });

  it('should report nothing for a command that printed nothing', () => {
    expect(parseAvdNameAnswer('')).toBe('');
  });
});

describe('resolveNextAvdNameChannel', () => {
  it('should try the older property when the channel answered but the image lacks the key', () => {
    expect(resolveNextAvdNameChannel({ channel: 'getprop-boot', didChannelRespond: true })).toBe('getprop-kernel');
  });

  it('should skip the sibling key when the adbd channel itself did not answer', () => {
    expect(resolveNextAvdNameChannel({ channel: 'getprop-boot', didChannelRespond: false })).toBe('console');
  });

  it('should fall back to the console once both properties are exhausted', () => {
    expect(resolveNextAvdNameChannel({ channel: 'getprop-kernel', didChannelRespond: true })).toBe('console');
  });

  it('should end after the console, whatever it answered', () => {
    expect(resolveNextAvdNameChannel({ channel: 'console', didChannelRespond: false })).toBeUndefined();
  });

  it('should refuse an unknown channel rather than silently ending the sequence', () => {
    expect(() => resolveNextAvdNameChannel({ channel: castTo<AvdNameChannel>('telepathy'), didChannelRespond: true }))
      .toThrow('Unhandled value: telepathy');
  });
});
