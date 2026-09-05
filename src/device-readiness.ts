/**
 * @file
 *
 * Pure helpers for deciding when a freshly-booted Android emulator is ready
 * enough to establish an Appium session, plus resolving the two readiness-wait
 * timeouts from the transport options. Kept separate from the integration-only
 * `transport-factory` so the parsing and default resolution stay unit-testable
 * (the factory itself needs a real emulator and is excluded from unit tests).
 *
 * Readiness is two independent questions, waited on in two phases:
 *
 * 1. **Is the guest idle?** `sys.boot_completed` fires *before* it is: package
 *    optimization (`dex2oat`) and system services keep churning after it, so a
 *    session established the instant it fires makes every one of UiAutomator2's
 *    serialized `adb` round-trips contend with that work and inflate ~3x. Gating
 *    the session on a later, quieter signal (the boot animation has stopped and
 *    the package manager is serving) lets it run against an idle guest instead.
 * 2. **Does the guest have a network?** Both idle signals are true well *before*
 *    the default network is created and validated — that lands ~80s into guest
 *    uptime, tens of seconds after the idle gate clears — and neither says
 *    anything about connectivity, so an idle-only gate hands the suite a device
 *    with no route. See {@link checkNetworkValidated} for the measurement and
 *    for why the three obvious connectivity probes are all wrong here.
 */

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

const ACTIVE_DEFAULT_NETWORK_PATTERN = /^\s*Active default network:\s*(?<networkId>\S+)/m;
const BOOT_ANIMATION_STOPPED_STATE = 'stopped';
const FIRST_VALIDATED_PATTERN = /\bfirstValidated\s+(?<timestamp>\d+)/;
const NETWORK_AGENT_INFO_MARKER = 'NetworkAgentInfo{';
const NETWORK_ID_PATTERN = /^\d+$/;
const PACKAGE_LINE_PREFIX = 'package:';
const VALIDATED_SCORE_POLICY = 'IS_VALIDATED';

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.deviceIdleTimeoutInMilliseconds}.
 */
export const DEFAULT_DEVICE_IDLE_TIMEOUT_IN_MILLISECONDS = 60_000;

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.networkReadyTimeoutInMilliseconds}.
 *
 * The budget starts *after* `sys.boot_completed`, where the measured wait on a
 * cold WHPX emulator is ~30s (validation at ~80s from boot, against a boot flag
 * at ~56s). The default is headroom for the starved/CI regime the other Android
 * budgets are already sized for, not the expected cost.
 */
export const DEFAULT_NETWORK_READY_TIMEOUT_IN_MILLISECONDS = 120_000;

/**
 * Parameters for {@link checkDeviceIdle}.
 */
export interface CheckDeviceIdleParams {
  /**
  Raw stdout of `adb shell getprop init.svc.bootanim`.
   */
  readonly bootAnimationProperty: string;

  /**
  Raw stdout of `adb shell cmd package list packages`.
   */
  readonly packageListOutput: string;
}

/**
 * Parameters for {@link checkNetworkValidated}.
 */
export interface CheckNetworkValidatedParams {
  /**
  Raw stdout of `adb shell dumpsys connectivity`.
   */
  readonly connectivityOutput: string;
}

/**
 * Decides whether a booted emulator is idle enough to start an Appium session,
 * from the raw output of the two probe commands.
 *
 * The guest is considered idle once the boot animation has stopped **and** the
 * package manager is serving (it lists at least one package). Both are binary,
 * later-than-`sys.boot_completed` signals, so this returns `true` well after the
 * premature boot-completed flag but without any latency thresholds.
 *
 * @param params - The sampled probe outputs.
 * @returns `true` when the guest is idle enough to proceed.
 */
export function checkDeviceIdle(params: CheckDeviceIdleParams): boolean {
  const isBootAnimationStopped = params.bootAnimationProperty.trim() === BOOT_ANIMATION_STOPPED_STATE;
  const isPackageManagerReady = params.packageListOutput
    .split('\n')
    .some((line) => line.trimStart().startsWith(PACKAGE_LINE_PREFIX));
  return isBootAnimationStopped && isPackageManagerReady;
}

/**
 * Decides whether a booted emulator has a working network, from the raw output
 * of `adb shell dumpsys connectivity`.
 *
 * Ready means the dump names an **active default network** *and* that network's
 * own agent info reports validation — either an `IS_VALIDATED` score policy or a
 * non-zero `firstValidated` timestamp. Both are required: a default network
 * exists for seconds before it validates, and during that window it carries no
 * usable route.
 *
 * Why this matters at all: the two {@link checkDeviceIdle} signals are satisfied
 * well before this one. Validation lands ~70-80s into guest uptime — measured on
 * `obsidian_test`, `created 70635 firstValidated 72681`, and on a cold boot of
 * `obsidian_screenshots`, `created 66870 firstValidated 79870`, which at 85s
 * uptime still scored `EVER_EVALUATED&IS_UNMETERED` with no `IS_VALIDATED` and
 * no `firstValidated` field at all. Against a boot flag at ~56s that leaves a
 * gap of tens of seconds on a fast host, and more on a slow one. A suite started
 * in that gap does not merely run slowly: a test that reaches the network runs
 * to completion against a silently empty result, which no assertion inside the
 * suite can tell apart from a genuinely empty feed.
 *
 * `dumpsys connectivity` is the honest source, and the three probes that look
 * like better ones are all wrong — each of them misled a full day of
 * investigation before this was understood:
 *
 * - `ip route` shows **no** default route on a healthy device: Android uses
 *   per-network policy routing, and the route lives in table 1015, not `main`.
 * - `ping` fails on a healthy device: QEMU user-mode NAT does not forward ICMP
 *   on Windows hosts.
 * - `getprop net.dns1` is empty on every modern Android: DNS went per-network
 *   in 8/9.
 *
 * @param params - The sampled probe output.
 * @returns `true` when the guest has a validated default network.
 */
export function checkNetworkValidated(params: CheckNetworkValidatedParams): boolean {
  const activeNetworkId = ACTIVE_DEFAULT_NETWORK_PATTERN.exec(params.connectivityOutput)?.groups?.['networkId'] ?? '';
  if (!NETWORK_ID_PATTERN.test(activeNetworkId)) {
    return false;
  }

  const agentInfo = extractNetworkAgentInfo(params.connectivityOutput, activeNetworkId);
  if (agentInfo.includes(VALIDATED_SCORE_POLICY)) {
    return true;
  }

  const firstValidatedTimestamp = Number(FIRST_VALIDATED_PATTERN.exec(agentInfo)?.groups?.['timestamp'] ?? '0');
  return firstValidatedTimestamp > 0;
}

/**
 * Resolves the post-boot device-idle wait timeout, applying the default when
 * the option is omitted.
 *
 * This bounds how long the factory waits for a freshly-started emulator to
 * become idle (see {@link checkDeviceIdle}) before establishing the session. A
 * value of `0` skips the wait entirely.
 *
 * @param options - The Android Appium transport options.
 * @returns The timeout in milliseconds.
 */
export function resolveDeviceIdleTimeoutInMilliseconds(
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.deviceIdleTimeoutInMilliseconds ?? DEFAULT_DEVICE_IDLE_TIMEOUT_IN_MILLISECONDS;
}

/**
 * Resolves the network-ready wait timeout, applying the default when the option
 * is omitted.
 *
 * This bounds how long the factory waits, after the idle gate, for the guest to
 * report a validated default network (see {@link checkNetworkValidated}) before
 * establishing the session. A value of `0` skips the wait entirely.
 *
 * @param options - The Android Appium transport options.
 * @returns The timeout in milliseconds.
 */
export function resolveNetworkReadyTimeoutInMilliseconds(
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.networkReadyTimeoutInMilliseconds ?? DEFAULT_NETWORK_READY_TIMEOUT_IN_MILLISECONDS;
}

/**
 * Extracts the `NetworkAgentInfo{…}` entry for one network id from a
 * connectivity dump.
 *
 * **Bounded to the entry's own line, and that bound is load-bearing.** A real
 * dump lists the active network's agent under `Current Networks:` and then, much
 * further down, a `NetworkOffer` per provider — and those offers carry
 * `IS_VALIDATED` in their score policies whatever the live network is doing. A
 * dump sampled here with an unvalidated default network held seven such offers,
 * so reading past the agent's own line reports *every* dump as validated. One
 * entry is one line in the observed output; an entry that ever wraps reads as
 * not-ready, which is the safe direction to be wrong in.
 *
 * @param connectivityOutput - Raw stdout of `adb shell dumpsys connectivity`.
 * @param networkId - The network id whose entry to extract.
 * @returns The entry's line, or an empty string when the dump has no such entry.
 */
function extractNetworkAgentInfo(connectivityOutput: string, networkId: string): string {
  const startIndex = connectivityOutput.indexOf(`${NETWORK_AGENT_INFO_MARKER}network{${networkId}}`);
  if (startIndex === -1) {
    return '';
  }

  const lineEndIndex = connectivityOutput.indexOf('\n', startIndex);
  return lineEndIndex === -1
    ? connectivityOutput.slice(startIndex)
    : connectivityOutput.slice(startIndex, lineEndIndex);
}
