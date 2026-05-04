/**
 * @file
 *
 * Builds the argument list for spawning the Android emulator.
 */

const DNS_SERVER = '8.8.8.8';

/**
 * Builds the argument list for spawning the Android emulator.
 *
 * @param avdName - The Android Virtual Device name.
 * @returns The argument array to pass to the emulator binary.
 */
export function buildEmulatorArgs(avdName: string): string[] {
  return ['-avd', avdName, '-no-snapshot-save', '-dns-server', DNS_SERVER];
}
