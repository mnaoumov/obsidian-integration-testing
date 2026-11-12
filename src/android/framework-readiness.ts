/**
 * @file
 *
 * Pure helpers for the framework-ready gate: the last readiness check before
 * the harness touches the guest's framework (`settings put`) and before
 * `remote()` hands the device to UiAutomator2.
 *
 * `sys.boot_completed`, the idle gate and the network gate all say that the
 * framework WAS serving. None of them says it still is. Under a one-core bulk
 * budget `system_server` can die after all three have passed — most likely its
 * watchdog firing under CPU starvation — and Android restarts it. Measured on
 * 2026-11-03 (release 17.8.1, `-cores 1`): `dumpsys connectivity` reported a
 * validated network at 07:44:39, the wake keyevent succeeded at 07:44:44, and
 * from 07:44:50 every `settings` call failed with `cmd: Can't find service:
 * settings`. A service that was up and is then gone is a restart, not a slow
 * first start, and a session created into it spends its whole retry budget
 * failing as a bare timeout.
 *
 * So the gate asks two things in one `adb shell` round-trip: are the services a
 * session needs registered (`service check`), and is `system_server` the same
 * process it was when the boot wait ended. The identity is
 * `sys.system_server.start_count` (with `start_uptime`), set by Android's
 * SystemServer since Android 11; a guest that does not set it is identified by
 * the `system_server` pid instead.
 */

import type { ObsidianAndroidAppiumTransportOptions } from '../transport/transport-options.ts';

const COUNT_PREFIX = 'count=';
const LOG_LINE_LIMIT = 40;
const PID_PREFIX = 'pid=';
const SERVICE_CHECK_PATTERN = /^Service\s+(?<name>\S+):\s+(?<state>found|not found)\s*$/;
const SYSTEM_SERVER_LOG_PATTERN = /Watchdog|system_server|SystemServer|FATAL EXCEPTION IN SYSTEM PROCESS/;
const UPTIME_PREFIX = 'uptime=';

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.frameworkReadyTimeoutInMilliseconds}.
 *
 * A `system_server` restart on an idle 4-core guest re-registers its services in
 * well under a minute; under the one-core bulk budget everything on the guest
 * runs several times slower, which is what the headroom is for.
 */
export const DEFAULT_FRAMEWORK_READY_TIMEOUT_IN_MILLISECONDS = 180_000;

/**
 * The framework services an Appium session needs registered.
 *
 * `settings` is what `settings put` and UiAutomator2's `hidden_api_policy`
 * calls reach; `package` and `activity` are what installing and starting
 * `io.appium.settings` and Obsidian reach; `input` is the key events; and
 * `connectivity` is the network gate's own probe.
 */
export const FRAMEWORK_SERVICE_NAMES: readonly string[] = ['settings', 'package', 'activity', 'input', 'connectivity'];

/**
 * Parameters for {@link buildFrameworkNotReadyMessage}.
 */
export interface BuildFrameworkNotReadyMessageParams {
  /**
  Raw `logcat -d -b crash` output, or `null` when it could not be read.
   */
  readonly crashLog: null | string;

  /**
  The device the gate ran on.
   */
  readonly deviceId: string;

  /**
  The last probe's verdict, or `undefined` when no probe was answered.
   */
  readonly lastVerdict: FrameworkProbeVerdict | undefined;

  /**
  Every restart the gate saw, oldest first.
   */
  readonly restarts: readonly SystemServerRestart[];

  /**
  Raw `logcat -d -b system` output, or `null` when it could not be read.
   */
  readonly systemLog: null | string;

  /**
  The budget the gate ran out of.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * One framework probe, parsed.
 */
export interface FrameworkProbe {
  /**
  Services `service check` reported as found.
   */
  readonly foundServices: readonly string[];

  /**
  The `system_server` identity, or `undefined` when the guest reported neither a start count nor a pid.
   */
  readonly identity: SystemServerIdentity | undefined;
}

/**
 * What one probe says about the framework, measured against the identity
 * recorded when the boot wait ended.
 */
export type FrameworkProbeVerdict = FrameworkReadyVerdict | FrameworkRestartedVerdict | FrameworkServicesMissingVerdict;

/**
 * The framework is ready.
 */
export interface FrameworkReadyVerdict {
  readonly kind: 'ready';
}

/**
 * `system_server` restarted since the baseline.
 */
export interface FrameworkRestartedVerdict extends SystemServerRestart {
  readonly kind: 'restarted';
}

/**
 * Some framework services are not registered yet.
 */
export interface FrameworkServicesMissingVerdict {
  readonly kind: 'services-missing';

  /**
  The services not registered, plus `system_server` when no identity was readable.
   */
  readonly missingServices: readonly string[];
}

/**
 * A `system_server` identified by its pid.
 */
export interface PidSystemServerIdentity {
  readonly kind: 'pid';

  /**
  The pid `pidof system_server` reported.
   */
  readonly pid: number;
}

/**
 * Parameters for {@link resolveFrameworkProbeVerdict}.
 */
export interface ResolveFrameworkProbeVerdictParams {
  /**
  The identity recorded when the boot wait ended, or `undefined` when none was readable.
   */
  readonly baseline: SystemServerIdentity | undefined;

  /**
  The probe just taken.
   */
  readonly probe: FrameworkProbe;
}

/**
 * A `system_server` identified by the guest's own start count.
 */
export interface StartCountSystemServerIdentity {
  /**
  `sys.system_server.start_count`: how many times system_server has started since boot.
   */
  readonly count: number;

  readonly kind: 'start-count';

  /**
  `sys.system_server.start_uptime`, when the guest sets it.
   */
  readonly uptime: string;
}

/**
 * Which `system_server` process is running, as far as the guest says.
 */
export type SystemServerIdentity = PidSystemServerIdentity | StartCountSystemServerIdentity;

/**
 * One observed `system_server` restart.
 */
export interface SystemServerRestart {
  readonly from: SystemServerIdentity;
  readonly to: SystemServerIdentity;
}

/**
 * Builds the error a gate that ran out of budget throws.
 *
 * It names a restart when one was seen, since that is the event a bare session
 * timeout used to hide, and carries the crash buffer and the watchdog lines so
 * the cause (watchdog, OOM, crash) is recorded rather than guessed.
 *
 * @param params - The gate's evidence.
 * @returns The message.
 */
export function buildFrameworkNotReadyMessage(params: BuildFrameworkNotReadyMessageParams): string {
  const { crashLog, deviceId, lastVerdict, restarts, systemLog, timeoutInMilliseconds } = params;
  const lines: string[] = [];

  if (restarts.length > 0) {
    const chain = restarts.map((restart) => describeSystemServerRestart(restart)).join('; ');
    lines.push(
      `The Android framework on device ${deviceId} did not come back within ${String(timeoutInMilliseconds)}ms after system_server restarted (${chain}).`,
      'A restart after boot is most often the system_server watchdog firing on a CPU-starved guest; the logs below say which it was.'
    );
  } else {
    lines.push(`The Android framework on device ${deviceId} was not ready within ${String(timeoutInMilliseconds)}ms.`);
  }

  if (lastVerdict === undefined) {
    lines.push('No framework probe was answered at all, so the guest itself may be wedged.');
  } else if (lastVerdict.kind === 'restarted') {
    lines.push(`The last probe saw system_server restart again (${describeSystemServerRestart(lastVerdict)}).`);
  } else if (lastVerdict.kind === 'services-missing') {
    lines.push(`Services still not registered at the last probe: ${lastVerdict.missingServices.join(', ')}.`);
  }

  lines.push(
    '',
    'logcat -d -b crash:',
    formatLogSection(crashLog, () => true),
    '',
    'logcat -d -b system (Watchdog / system_server lines):',
    formatLogSection(systemLog, (line) => SYSTEM_SERVER_LOG_PATTERN.test(line))
  );
  return lines.join('\n');
}

/**
 * The guest-side shell script one probe runs: the identity, then one
 * `service check` per framework service.
 *
 * One round-trip on purpose. The gate runs exactly when the guest is starved,
 * where every `adb` call is the expensive part, so the five checks and three
 * properties share one.
 *
 * @returns The script, to pass as a single `adb shell` argument.
 */
export function buildFrameworkProbeScript(): string {
  return [
    `echo ${COUNT_PREFIX}$(getprop sys.system_server.start_count)`,
    `echo ${UPTIME_PREFIX}$(getprop sys.system_server.start_uptime)`,
    `echo ${PID_PREFIX}$(pidof system_server)`,
    `for s in ${FRAMEWORK_SERVICE_NAMES.join(' ')}; do service check $s; done`
  ].join('; ');
}

/**
 * Says whether two identities name different `system_server` processes.
 *
 * Only identities of the same kind are compared. A start count that one probe
 * could read and the next could not says nothing about a restart, and reading
 * it as one would send the gate into a recovery for an event that never
 * happened.
 *
 * @param baseline - The earlier identity.
 * @param current - The later identity.
 * @returns `true` when a restart is proven.
 */
export function checkIsSystemServerRestarted(baseline: SystemServerIdentity, current: SystemServerIdentity): boolean {
  return baseline.kind === 'start-count' && current.kind === 'start-count' ? baseline.count !== current.count || baseline.uptime !== current.uptime : baseline.kind === 'pid' && current.kind === 'pid' && baseline.pid !== current.pid;
}

/**
 * Describes an identity for a log line.
 *
 * @param identity - The identity.
 * @returns E.g. `start count 1` or `pid 512`.
 */
export function describeSystemServerIdentity(identity: SystemServerIdentity): string {
  return identity.kind === 'start-count' ? `start count ${String(identity.count)}` : `pid ${String(identity.pid)}`;
}

/**
 * Describes a restart for a log line.
 *
 * @param restart - The restart.
 * @returns E.g. `start count 1 -> 2`.
 */
export function describeSystemServerRestart(restart: SystemServerRestart): string {
  const { from, to } = restart;
  if (from.kind === 'start-count' && to.kind === 'start-count') {
    return `start count ${String(from.count)} -> ${String(to.count)}`;
  }

  return from.kind === 'pid' && to.kind === 'pid' ? `pid ${String(from.pid)} -> ${String(to.pid)}` : `${describeSystemServerIdentity(from)} -> ${describeSystemServerIdentity(to)}`;
}

/**
 * Parses the output of {@link buildFrameworkProbeScript}.
 *
 * The start count wins over the pid when both are present, since it is the
 * guest's own statement that a restart happened, while a pid can in principle
 * be reused.
 *
 * @param output - Raw stdout.
 * @returns The parsed probe.
 */
export function parseFrameworkProbeOutput(output: string): FrameworkProbe {
  let countText = '';
  let uptimeText = '';
  let pidText = '';
  const foundServices: string[] = [];

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith(COUNT_PREFIX)) {
      countText = line.slice(COUNT_PREFIX.length).trim();
    } else if (line.startsWith(UPTIME_PREFIX)) {
      uptimeText = line.slice(UPTIME_PREFIX.length).trim();
    } else if (line.startsWith(PID_PREFIX)) {
      pidText = line.slice(PID_PREFIX.length).trim();
    } else {
      const match = SERVICE_CHECK_PATTERN.exec(line);
      const name = match?.groups?.['name'];
      if (name !== undefined && match?.groups?.['state'] === 'found') {
        foundServices.push(name);
      }
    }
  }

  return { foundServices, identity: resolveIdentity(countText, uptimeText, pidText) ?? undefined };
}

/**
 * Judges one probe against the boot-time identity.
 *
 * A restart is reported before missing services, because it is the event the
 * caller has to act on: re-run the idle gate, and adopt the new identity.
 *
 * @param params - The baseline and the probe.
 * @returns The verdict.
 */
export function resolveFrameworkProbeVerdict(params: ResolveFrameworkProbeVerdictParams): FrameworkProbeVerdict {
  const { baseline, probe } = params;
  if (baseline !== undefined && probe.identity !== undefined && checkIsSystemServerRestarted(baseline, probe.identity)) {
    return { from: baseline, kind: 'restarted', to: probe.identity };
  }

  const missingServices = FRAMEWORK_SERVICE_NAMES.filter((name) => !probe.foundServices.includes(name));
  if (probe.identity === undefined) {
    missingServices.push('system_server');
  }

  return missingServices.length > 0 ? { kind: 'services-missing', missingServices } : { kind: 'ready' };
}

/**
 * Resolves the framework-ready gate's budget, applying the default when the
 * option is omitted. A value of `0` skips the gate.
 *
 * @param options - The Android Appium transport options.
 * @returns The timeout in milliseconds.
 */
export function resolveFrameworkReadyTimeoutInMilliseconds(
  // eslint-disable-next-line typescript-dev-toolkit/params-options-name-match -- Permanent: `ObsidianAndroidAppiumTransportOptions` is one transport options bag read by six helpers, so no per-owner name can satisfy them all.
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.frameworkReadyTimeoutInMilliseconds ?? DEFAULT_FRAMEWORK_READY_TIMEOUT_IN_MILLISECONDS;
}

function formatLogSection(logText: null | string, isRelevant: (line: string) => boolean): string {
  if (logText === null) {
    return '(could not be read)';
  }

  const lines = logText.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '' && !line.startsWith('---------') && isRelevant(line));
  return lines.length === 0 ? '(empty)' : lines.slice(-LOG_LINE_LIMIT).join('\n');
}

function parsePositiveInteger(text: string): null | number {
  if (!/^\d+$/.test(text)) {
    return null;
  }

  const value = Number(text);
  return value > 0 ? value : null;
}

function resolveIdentity(countText: string, uptimeText: string, pidText: string): null | SystemServerIdentity {
  const count = parsePositiveInteger(countText);
  if (count !== null) {
    return { count, kind: 'start-count', uptime: uptimeText };
  }

  // `pidof` prints every match; system_server is one process, so several pids are not an identity.
  const pid = parsePositiveInteger(pidText);
  return pid === null ? null : { kind: 'pid', pid };
}
