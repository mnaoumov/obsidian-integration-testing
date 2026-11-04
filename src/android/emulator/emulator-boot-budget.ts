/**
 * @file
 *
 * The budget an auto-started emulator gets to appear in `adb devices` AND
 * report `sys.boot_completed`, scaled by the guest core count it was launched
 * with.
 *
 * **300 s was sized at 4 guest cores and does not hold at 1.** The measured
 * ~90-220 s cold boot was taken at the default `-cores 4`. Since
 * `buildEmulatorArguments` caps `-cores` at `BULK_CORES`, a bulk run on a
 * machine that gives each item one processor boots with `-cores 1`, and
 * measured 1-core cold boots of `obsidian_test` (Android 37
 * google_apis_playstore_ps16k x86_64, 8 GB RAM) on 2026-11-03 straddle the
 * line: three runs had adb up at ~30 s and were still not booted at 300 s
 * (connected for the last 260-272 s of the budget), one booted at ~264 s, and
 * retries booted ~250-290 s after launch. So a 1-core boot gets 600 s, about
 * twice the slowest one observed. Raising the core count instead is not the
 * harness's call: `BULK_CORES` is the caller's processor share.
 *
 * The 300 s itself replaced 120 s, which sat inside the measured range: on
 * 2026-10-23, at 100% host CPU, three runs in a row spent 69-114 s waiting for
 * the device to appear and were left 10-54 s for `sys.boot_completed`, so both
 * boot attempts of every run failed.
 */

/**
 * The boot budget at two or more guest cores, and for a device whose core
 * count this run does not know (a reused one).
 */
export const DEFAULT_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS = 300_000;

/**
 * The boot budget at one guest core: about twice the slowest measured 1-core
 * cold boot (~290 s).
 */
export const SINGLE_CORE_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS = 600_000;

/**
 * Parameters for {@link buildEmulatorBootTimeoutMessage}.
 */
export interface BuildEmulatorBootTimeoutMessageParams {
  /**
  The budget that ran out.
   */
  readonly bootBudget: EmulatorBootBudget;

  /**
  How long the device had been listed in `adb devices` when the budget ran out.
   */
  readonly connectedForInMilliseconds: number;

  /**
  The device that never reported a finished boot.
   */
  readonly deviceId: string;
}

/**
 * The resolved boot budget, with what it was resolved from, so a timeout can
 * say which core count and which budget were in force.
 */
export interface EmulatorBootBudget {
  /**
  The guest core count the emulator was launched with; `undefined` for a device this run did not launch.
   */
  readonly coreCount: number | undefined;

  /**
  Whether the caller set the budget with `emulatorBootTimeoutInMilliseconds`.
   */
  readonly isOverridden: boolean;

  /**
  The budget in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * Parameters for {@link resolveEmulatorBootBudget}.
 */
export interface ResolveEmulatorBootBudgetParams {
  /**
  The guest core count the emulator is launched with; `undefined` for a reused device.
   */
  readonly coreCount?: number | undefined;

  /**
  The `emulatorBootTimeoutInMilliseconds` transport option, when set.
   */
  readonly overrideInMilliseconds?: number | undefined;
}

/**
 * Builds the message for a device that was listed but never reported
 * `sys.boot_completed` within its budget, naming the budget and the core count
 * it was scaled by, so a 1-core run is not read as a 4-core one.
 *
 * @param params - The budget, the device, and how long it was connected.
 * @returns The message.
 */
export function buildEmulatorBootTimeoutMessage(params: BuildEmulatorBootTimeoutMessageParams): string {
  const { bootBudget, connectedForInMilliseconds, deviceId } = params;
  return `Device "${deviceId}" connected but did not finish booting within ${String(bootBudget.timeoutInMilliseconds)}ms (it was connected for the last ${String(connectedForInMilliseconds)}ms of that budget; ${describeEmulatorBootBudget(bootBudget)}).`;
}

/**
 * Describes a boot budget for a log line or a timeout message.
 *
 * @param budget - The resolved budget.
 * @returns For example `600000ms boot budget (1 guest core)`.
 */
export function describeEmulatorBootBudget(budget: EmulatorBootBudget): string {
  const coreClause = budget.coreCount === undefined
    ? 'guest core count unknown: the device was not launched by this run'
    : `${String(budget.coreCount)} guest core${budget.coreCount === 1 ? '' : 's'}`;
  const sourceClause = budget.isOverridden ? ', set by emulatorBootTimeoutInMilliseconds' : '';
  return `${String(budget.timeoutInMilliseconds)}ms boot budget (${coreClause}${sourceClause})`;
}

/**
 * Resolves the emulator boot budget from the guest core count and the caller's
 * override.
 *
 * @param params - The core count and the override.
 * @returns The budget, and what it was resolved from.
 * @throws If the override is not a positive safe integer.
 */
export function resolveEmulatorBootBudget(params: ResolveEmulatorBootBudgetParams): EmulatorBootBudget {
  const { coreCount, overrideInMilliseconds } = params;
  if (overrideInMilliseconds !== undefined) {
    if (!Number.isSafeInteger(overrideInMilliseconds) || overrideInMilliseconds < 1) {
      throw new Error('emulatorBootTimeoutInMilliseconds must be a positive safe integer.');
    }
    return { coreCount, isOverridden: true, timeoutInMilliseconds: overrideInMilliseconds };
  }
  return {
    coreCount,
    isOverridden: false,
    timeoutInMilliseconds: coreCount === 1 ? SINGLE_CORE_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS : DEFAULT_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS
  };
}
