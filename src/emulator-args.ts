/**
 * @file
 *
 * Builds the argument list for spawning the Android emulator.
 */

const DNS_SERVER = '8.8.8.8';

/**
 * Parameters for {@link buildEmulatorArgs}.
 */
export interface BuildEmulatorArgsParams {
  /** The Android Virtual Device name. */
  readonly avdName: string;

  /**
   * Whether to run the emulator headless (`-no-window`), so it never steals
   * focus. Resolved from the `isEmulatorVisible` transport option.
   */
  readonly isHidden: boolean;
}

/**
 * Builds the argument list for spawning the Android emulator.
 *
 * @param params - The emulator argument parameters.
 * @returns The argument array to pass to the emulator binary.
 */
export function buildEmulatorArgs(params: BuildEmulatorArgsParams): string[] {
  const args = ['-avd', params.avdName, '-no-snapshot-save', '-dns-server', DNS_SERVER];
  if (params.isHidden) {
    args.push('-no-window');
  }
  return args;
}
