/**
 * @file
 *
 * Builds the `adb shell settings …` argument list.
 *
 * Split out of {@link ./device-settings.ts} for the same reason
 * {@link ./adb-device-list.ts} is split out of the transport factory: the
 * argument list is pure and worth unit-testing, while the call that runs it is
 * integration-time code that a unit test cannot reach. Keeping them in one file
 * would put the namespace default inside a coverage-ignored block, where nothing
 * checks that it is what the documentation claims.
 */

/**
 * The `settings` namespaces this helper addresses.
 */
export enum DeviceSettingNamespace {
  /**
   * Device-wide settings, e.g. `hide_error_dialogs`.
   */
  Global = 'global',

  /**
   * Per-user settings the system reads, e.g. `show_ime_with_hard_keyboard`.
   */
  Secure = 'secure',

  /**
   * Per-user settings apps may read, e.g. `screen_brightness`.
   */
  System = 'system'
}

/**
 * The `settings` sub-commands this helper issues.
 */
export enum DeviceSettingVerb {
  /**
   * Removes the setting, returning it to never-having-been-written.
   */
  Delete = 'delete',

  /**
   * Reads the setting, printing `null` when it has never been written.
   */
  Get = 'get',

  /**
   * Writes the setting.
   */
  Put = 'put'
}

/**
 * Parameters for {@link buildDeviceSettingsCommandArguments}.
 */
export interface BuildDeviceSettingsCommandArgumentsParams {
  /**
   * The setting's name within {@link namespace}, e.g. `show_ime_with_hard_keyboard`.
   */
  readonly name: string;

  /**
   * The settings namespace the name lives in.
   *
   * @default {@link DeviceSettingNamespace.Secure}
   */
  readonly namespace?: DeviceSettingNamespace;

  /**
   * The value to write. Meaningful only for {@link DeviceSettingVerb.Put}.
   */
  readonly value?: string;

  /**
   * The sub-command to issue.
   */
  readonly verb: DeviceSettingVerb;
}

/**
 * Builds the arguments for `adb shell settings <verb> <namespace> <name> [value]`.
 *
 * @param params - The sub-command, the setting, its namespace and — for a write — its value.
 * @returns The arguments to hand to `runAdbText`, `shell` included.
 */
export function buildDeviceSettingsCommandArguments(params: BuildDeviceSettingsCommandArgumentsParams): string[] {
  const namespace = params.namespace ?? DeviceSettingNamespace.Secure;
  const value = params.verb === DeviceSettingVerb.Put && params.value !== undefined ? [params.value] : [];

  return ['shell', 'settings', params.verb, namespace, params.name, ...value];
}
