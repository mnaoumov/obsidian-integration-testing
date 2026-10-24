import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildNoLaunchedDeviceMessage,
  resolveLaunchedDevice,
  splitNewDevices
} from './launched-device-selection.ts';

/**
 * The handset serial from the run that ran its suite on the phone.
 */
const HANDSET = '3C15BN001Y900000';

describe('splitNewDevices', () => {
  /*
   * The reported defect: the handset was offline or unauthorized when the "before" snapshot was taken, came
   * online during the boot, and the old wait took it because it was the first new id.
   */
  it('should never offer a handset that came online during the boot as an emulator', () => {
    const split = splitNewDevices({ connectedDeviceIds: [HANDSET], deviceIdsBefore: [] });

    expect(split.emulatorDeviceIds).toEqual([]);
    expect(split.nonEmulatorDeviceIds).toEqual([HANDSET]);
  });

  it('should offer the emulator even when the handset is listed first', () => {
    const split = splitNewDevices({ connectedDeviceIds: [HANDSET, 'emulator-5554'], deviceIdsBefore: [] });

    expect(split.emulatorDeviceIds).toEqual(['emulator-5554']);
    expect(split.nonEmulatorDeviceIds).toEqual([HANDSET]);
  });

  it('should leave out every device that was online before the launch', () => {
    const split = splitNewDevices({
      connectedDeviceIds: [HANDSET, 'emulator-5554', 'emulator-5556'],
      deviceIdsBefore: [HANDSET, 'emulator-5554']
    });

    expect(split).toEqual({ emulatorDeviceIds: ['emulator-5556'], nonEmulatorDeviceIds: [] });
  });

  it('should treat a TCP-attached device as not an emulator', () => {
    expect(splitNewDevices({ connectedDeviceIds: ['192.168.1.20:5555'], deviceIdsBefore: [] }).nonEmulatorDeviceIds)
      .toEqual(['192.168.1.20:5555']);
  });
});

describe('resolveLaunchedDevice', () => {
  it('should take the emulator serving the launched AVD', () => {
    expect(resolveLaunchedDevice({
      avdName: 'obsidian_test',
      candidates: [{ deviceId: 'emulator-5554', probedAvdName: 'obsidian_test' }]
    })).toEqual({ deviceId: 'emulator-5554', otherAvdDeviceIds: [], unansweredDeviceIds: [] });
  });

  /*
   * A second emulator another project started at the same time must not be adopted either.
   */
  it('should rule out an emulator serving another AVD', () => {
    expect(resolveLaunchedDevice({
      avdName: 'obsidian_test',
      candidates: [
        { deviceId: 'emulator-5556', probedAvdName: 'asc_test' },
        { deviceId: 'emulator-5554', probedAvdName: 'obsidian_test' }
      ]
    })).toEqual({ deviceId: 'emulator-5554', otherAvdDeviceIds: ['emulator-5556'], unansweredDeviceIds: [] });
  });

  it('should not adopt a new emulator that has not said which AVD it serves', () => {
    expect(resolveLaunchedDevice({
      avdName: 'obsidian_test',
      candidates: [{ deviceId: 'emulator-5554', probedAvdName: undefined }]
    })).toEqual({ deviceId: undefined, otherAvdDeviceIds: [], unansweredDeviceIds: ['emulator-5554'] });
  });

  it('should find nothing when there are no candidates', () => {
    expect(resolveLaunchedDevice({ avdName: 'obsidian_test', candidates: [] }))
      .toEqual({ deviceId: undefined, otherAvdDeviceIds: [], unansweredDeviceIds: [] });
  });
});

describe('buildNoLaunchedDeviceMessage', () => {
  const TIMEOUT_IN_MILLISECONDS = 120_000;

  it('should say the emulator never registered when the last listing was empty', () => {
    const message = buildNoLaunchedDeviceMessage({
      lastListedDevices: [],
      lastListingFailure: undefined,
      listingFailureCount: 0,
      pollCount: 50,
      retriedListingCount: 0,
      timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
    });

    expect(message).toBe(
      'No new emulator device appeared within 120000ms, and the emulator process is still running. '
        + 'The last listing showed no devices: the emulator never registered with the adb server.'
    );
  });

  it('should say adbd never came up for an emulator stuck offline', () => {
    const message = buildNoLaunchedDeviceMessage({
      lastListedDevices: [{ deviceId: 'emulator-5554', state: 'offline' }],
      lastListingFailure: undefined,
      listingFailureCount: 0,
      pollCount: 50,
      retriedListingCount: 0,
      timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
    });

    expect(message).toContain('The last listing showed: emulator-5554 offline.');
    expect(message).toContain('adbd never came up');
  });

  it('should not blame adbd for a handset that is offline', () => {
    const message = buildNoLaunchedDeviceMessage({
      lastListedDevices: [{ deviceId: HANDSET, state: 'offline' }],
      lastListingFailure: undefined,
      listingFailureCount: 0,
      pollCount: 50,
      retriedListingCount: 0,
      timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
    });

    expect(message).toContain(`The last listing showed: ${HANDSET} offline.`);
    expect(message).not.toContain('adbd');
  });

  it('should report failed listings and the last one', () => {
    const message = buildNoLaunchedDeviceMessage({
      lastListedDevices: undefined,
      lastListingFailure: {
        elapsedInMilliseconds: 5010,
        exitCode: null,
        outcome: 'timed-out',
        signal: 'SIGTERM',
        standardError: '',
        timeoutInMilliseconds: 30_000
      },
      listingFailureCount: 3,
      pollCount: 3,
      retriedListingCount: 0,
      timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
    });

    expect(message).toContain('No device listing succeeded during the wait.');
    expect(message).toContain('3 of 3 listing(s) failed; the last: no answer within its 30.0s budget');
  });

  it('should name the host load when listings answered only on their retry', () => {
    const message = buildNoLaunchedDeviceMessage({
      lastListedDevices: [{ deviceId: 'emulator-5554', state: 'offline' }],
      lastListingFailure: undefined,
      listingFailureCount: 0,
      pollCount: 7,
      retriedListingCount: 7,
      timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
    });

    expect(message).toContain('7 of 7 listing(s) answered only on a retry');
    expect(message).toContain('more likely starved than broken');
  });
});
