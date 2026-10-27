import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildAvdSnapshotDirectoryCandidates,
  buildSnapshotAgeMessage
} from './emulator-snapshot.ts';

const AVD_NAME = 'obsidian_test';
const HOME_DIRECTORY = 'C:/Users/tester';
const BACKSLASH_CODE_POINT = 92;
const BACKSLASH = String.fromCodePoint(BACKSLASH_CODE_POINT);

describe('buildAvdSnapshotDirectoryCandidates', () => {
  it('should fall back to the AVD home under the user home when nothing is set', () => {
    const candidates = buildAvdSnapshotDirectoryCandidates({ avdName: AVD_NAME, environment: {}, homeDirectory: HOME_DIRECTORY });

    expect(candidates).toStrictEqual(['C:/Users/tester/.android/avd/obsidian_test.avd/snapshots/default_boot']);
  });

  it('should prefer ANDROID_AVD_HOME, which the emulator itself prefers', () => {
    const candidates = buildAvdSnapshotDirectoryCandidates({
      avdName: AVD_NAME,
      environment: { ANDROID_AVD_HOME: 'D:/avds' },
      homeDirectory: HOME_DIRECTORY
    });

    expect(candidates[0]).toBe('D:/avds/obsidian_test.avd/snapshots/default_boot');
  });

  it('should offer the ANDROID_SDK_HOME AVD home between the two', () => {
    const candidates = buildAvdSnapshotDirectoryCandidates({
      avdName: AVD_NAME,
      environment: { ANDROID_AVD_HOME: 'D:/avds', ANDROID_SDK_HOME: 'E:/sdk-home' },
      homeDirectory: HOME_DIRECTORY
    });

    expect(candidates).toStrictEqual([
      'D:/avds/obsidian_test.avd/snapshots/default_boot',
      'E:/sdk-home/.android/avd/obsidian_test.avd/snapshots/default_boot',
      'C:/Users/tester/.android/avd/obsidian_test.avd/snapshots/default_boot'
    ]);
  });

  it('should not double a separator a configured home already ends with', () => {
    const candidates = buildAvdSnapshotDirectoryCandidates({
      avdName: AVD_NAME,
      environment: { ANDROID_AVD_HOME: 'D:/avds//' },
      homeDirectory: HOME_DIRECTORY
    });

    expect(candidates[0]).toBe('D:/avds/obsidian_test.avd/snapshots/default_boot');
  });

  it('should trim a trailing backslash, which is how a Windows home is usually written', () => {
    const windowsAvdHome = String.raw`D:\avds`;
    const candidates = buildAvdSnapshotDirectoryCandidates({
      avdName: AVD_NAME,
      environment: { ANDROID_AVD_HOME: `${windowsAvdHome}${BACKSLASH}` },
      homeDirectory: HOME_DIRECTORY
    });

    expect(candidates[0]).toBe(`${windowsAvdHome}/obsidian_test.avd/snapshots/default_boot`);
  });

  it('should ignore an empty override rather than rooting the path at it', () => {
    const candidates = buildAvdSnapshotDirectoryCandidates({
      avdName: AVD_NAME,
      environment: { ANDROID_AVD_HOME: '', ANDROID_SDK_HOME: '' },
      homeDirectory: HOME_DIRECTORY
    });

    expect(candidates).toStrictEqual(['C:/Users/tester/.android/avd/obsidian_test.avd/snapshots/default_boot']);
  });
});

describe('buildSnapshotAgeMessage', () => {
  it('should date the snapshot being resumed, so staleness is visible in the log', () => {
    const message = buildSnapshotAgeMessage({ avdName: AVD_NAME, savedAt: new Date('2026-08-31T12:00:00.000Z') });

    expect(message).toContain('obsidian_test');
    expect(message).toContain('resuming `default_boot` saved 2026-08-31T12:00:00.000Z');
  });

  it('should say a fresh AVD has none, which is not a failure', () => {
    const message = buildSnapshotAgeMessage({ avdName: AVD_NAME });

    expect(message).toContain('no `default_boot` snapshot was found');
    expect(message).toContain('cold-boots and saves one for the next');
  });
});
