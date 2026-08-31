/**
 * @file
 *
 * Pure helpers for recognizing a **wedged** Appium server and deciding what to
 * do about it. Kept separate from the integration-only `transport-factory` so
 * the classification, the remedy decision and the message stay unit-testable
 * (the factory itself needs a real device and is excluded from unit tests).
 *
 * A wedged server is one that is still **live** — it listens on its port and
 * answers `/status` with `ready: true` — but is no longer **usable**: its
 * `appium-adb` can no longer enumerate devices, so every session creation dies
 * with `Could not find a connected Android device in <n>ms` while the host's own
 * `adb devices` lists the device instantly. Liveness is not readiness, and the
 * error names the wrong subject: it blames a device that is demonstrably
 * present, which sends whoever reads it to `adb devices` — the one diagnostic
 * that actively misleads here.
 *
 * The wedge develops over time in a long-lived server (one auto-started by an
 * earlier run and left listening), so the preflight cannot see it coming: it can
 * only be recognized from the failed session, cross-checked against the host's
 * adb.
 */

import { errorToString } from './error-to-string.ts';

/**
 * The fragment `appium-adb` throws when it cannot enumerate devices —
 * `` `Could not find a connected Android device in ${timeoutMs}ms` `` from its
 * `getDevicesWithRetry` (`lib/tools/system-calls.ts`). Matched as a substring so
 * the timeout value and any wrapping by WebdriverIO do not affect it.
 */
const DEVICE_NOT_FOUND_MESSAGE_FRAGMENT = 'Could not find a connected Android device';

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_MINUTE = MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE;

/**
 * Parameters for {@link buildWedgedAppiumServerMessage}.
 */
export interface BuildWedgedAppiumServerMessageParams {
  /**
  Origin of the Appium server that could not see the device (e.g. `http://localhost:4723`).
   */
  readonly appiumOrigin: string;

  /**
  The device the host's adb can see but Appium cannot.
   */
  readonly deviceId: string;

  /**
  Why this run is reporting rather than restarting.
   */
  readonly reason: WedgedAppiumServerReportReason;

  /**
  How long the server has been running, when known from its marker.
   */
  readonly serverAgeInMilliseconds?: number | undefined;

  /**
  PID of the server, when known from its marker.
   */
  readonly serverPid?: number | undefined;
}

/**
 * The server is not to blame: either the failure was a different error, or the
 * host's adb cannot see the device either. The original error is rethrown.
 */
export interface NotWedgedVerdict {
  /**
  Which of the two honest-failure cases this is.
   */
  readonly reason: 'device-absent' | 'other-error';

  /**
  Discriminant.
   */
  readonly remedy: 'not-wedged';
}

/**
 * The server is wedged but must not be touched by this run.
 */
export interface ReportServerVerdict {
  /**
  Why this run is reporting rather than restarting.
   */
  readonly reason: WedgedAppiumServerReportReason;

  /**
  Discriminant.
   */
  readonly remedy: 'report';
}

/**
 * Parameters for {@link resolveWedgedAppiumServerRemedy}.
 */
export interface ResolveWedgedAppiumServerRemedyParams {
  /**
  Device IDs the **host's** adb currently lists (the cross-check that convicts the server).
   */
  readonly connectedDeviceIds: readonly string[];

  /**
  The device the session was requested against.
   */
  readonly deviceId: string;

  /**
  The error the session attempt failed with.
   */
  readonly error: unknown;

  /**
  Whether the server was already listening and was adopted, rather than started by this run.
   */
  readonly isAdoptedServer: boolean;

  /**
  Whether this run may start an Appium server (`shouldAutoStartAppium` is not `false`).
   */
  readonly isAutoStartAllowed: boolean;

  /**
  Whether the adopted server's marker proves an earlier run of this harness started it.
   */
  readonly isHarnessOwnedServer: boolean;
}

/**
 * The server is wedged and an earlier run of this harness started it, so this
 * run may replace it.
 */
export interface RestartServerVerdict {
  /**
  Always the harness-owned case.
   */
  readonly reason: 'harness-owned';

  /**
  Discriminant.
   */
  readonly remedy: 'restart';
}

/**
 * The classification of a failed session attempt.
 *
 * `'device-absent'` and `'other-error'` are the not-wedged verdicts: the
 * original error was honest and is rethrown untouched.
 */
export type WedgedAppiumServerReason = 'device-absent' | 'harness-owned' | 'other-error' | WedgedAppiumServerReportReason;

/**
 * What the factory should do with a failed session attempt.
 */
export type WedgedAppiumServerRemedy = 'not-wedged' | 'report' | 'restart';

/**
 * Why a wedged server is only reported rather than restarted. Each maps to its
 * own remedy sentence — the whole point of the rewrite is that the message says
 * what *this* run can and cannot do about the server it found.
 */
export type WedgedAppiumServerReportReason =
  | 'auto-start-disabled'
  | 'foreign-server'
  | 'freshly-started'
  | 'restart-did-not-help';

/**
 * The verdict on a failed session attempt, discriminated by `remedy` so a
 * `'report'` verdict carries a reason {@link buildWedgedAppiumServerMessage} can
 * turn into advice.
 */
export type WedgedAppiumServerVerdict = NotWedgedVerdict | ReportServerVerdict | RestartServerVerdict;

/**
 * Builds the error message that replaces `Could not find a connected Android
 * device`, naming the **server** and stating the evidence — the host's adb can
 * see the device, so the server is the thing that is stale.
 *
 * @param params - The server, the device, and why this run is not restarting it.
 * @returns The message.
 */
export function buildWedgedAppiumServerMessage(params: BuildWedgedAppiumServerMessageParams): string {
  const lines = [
    `The Appium server at ${params.appiumOrigin} cannot see Android device ${params.deviceId}, although this host's adb can.`,
    'The server is stale — its adb connection is wedged — not the device, so `adb devices` will list the device and mislead you.',
    resolveRemedyAdvice(params)
  ];

  const provenance = describeServer(params);
  if (provenance) {
    lines.push(provenance);
  }

  return lines.join('\n');
}

/**
 * Checks whether a failed session attempt is `appium-adb`'s device-enumeration
 * failure. The whole `cause` chain is searched, so WebdriverIO's wrapping of the
 * server's error does not hide it.
 *
 * @param error - The error the session attempt failed with.
 * @returns `true` when it is the device-not-found failure.
 */
export function checkIsAppiumDeviceNotFoundError(error: unknown): boolean {
  return errorToString(error).includes(DEVICE_NOT_FOUND_MESSAGE_FRAGMENT);
}

/**
 * Checks whether an Appium `/status` body reports a server that is accepting new
 * sessions.
 *
 * Deliberately **tolerant**: only an explicit `ready: false` (Appium sets it
 * while shutting down) is treated as not-ready. A body that cannot be parsed, or
 * that omits the flag, reads as ready — an unrecognized shape must not make a
 * healthy server look unreachable.
 *
 * This does not catch the wedge (a wedged server still answers `ready: true`);
 * it closes the adjacent hole of adopting a server that is on its way down.
 *
 * @param statusBody - The raw `/status` response body.
 * @returns `false` only when the server explicitly reports itself not ready.
 */
export function checkIsAppiumStatusReady(statusBody: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusBody);
  } catch {
    return true;
  }

  return readReadyFlag(parsed) !== false;
}

/**
 * Decides what to do with a failed session attempt.
 *
 * The device-not-found error is only evidence against the server when the host's
 * adb *can* still see the device; otherwise the error was honest and is left
 * alone. A server this harness started in an earlier run is restarted (the
 * confirmed remedy); every other wedged server is reported rather than killed,
 * because terminating a process this run does not own is not its call to make.
 *
 * @param params - The failed attempt and what is known about the server.
 * @returns The verdict.
 */
export function resolveWedgedAppiumServerRemedy(params: ResolveWedgedAppiumServerRemedyParams): WedgedAppiumServerVerdict {
  if (!checkIsAppiumDeviceNotFoundError(params.error)) {
    return { reason: 'other-error', remedy: 'not-wedged' };
  }

  if (!params.connectedDeviceIds.includes(params.deviceId)) {
    return { reason: 'device-absent', remedy: 'not-wedged' };
  }

  if (!params.isAdoptedServer) {
    return { reason: 'freshly-started', remedy: 'report' };
  }

  if (!params.isAutoStartAllowed) {
    return { reason: 'auto-start-disabled', remedy: 'report' };
  }

  if (!params.isHarnessOwnedServer) {
    return { reason: 'foreign-server', remedy: 'report' };
  }

  return { reason: 'harness-owned', remedy: 'restart' };
}

function describeServer(params: BuildWedgedAppiumServerMessageParams): string {
  if (params.serverPid === undefined) {
    return '';
  }

  const age = params.serverAgeInMilliseconds === undefined ? '' : `, running for ${formatAge(params.serverAgeInMilliseconds)}`;
  return `The server was started by an earlier obsidian-integration-testing run (pid ${String(params.serverPid)}${age}).`;
}

function formatAge(ageInMilliseconds: number): string {
  if (ageInMilliseconds < MILLISECONDS_PER_MINUTE) {
    return `${String(Math.round(ageInMilliseconds / MILLISECONDS_PER_SECOND))}s`;
  }

  return `${String(Math.round(ageInMilliseconds / MILLISECONDS_PER_MINUTE))}min`;
}

function readReadyFlag(parsed: unknown): boolean | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const value = record['value'];
  const nested = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['ready'] : undefined;
  const ready = nested ?? record['ready'];
  return typeof ready === 'boolean' ? ready : undefined;
}

function resolveRemedyAdvice(params: BuildWedgedAppiumServerMessageParams): string {
  const advice: Record<WedgedAppiumServerReportReason, string> = {
    'auto-start-disabled': `Appium auto-start is disabled (\`shouldAutoStartAppium: false\`), so this server is yours to manage: kill it and start a fresh one on ${params.appiumOrigin}, then re-run.`,
    'foreign-server': `This server was not started by obsidian-integration-testing, so it was left running: kill it and start a fresh one on ${params.appiumOrigin}, then re-run.`,
    'freshly-started': 'This server was started by this run, so restarting it would change nothing: check that adb and the emulator agree (`adb kill-server && adb devices`), then re-run.',
    'restart-did-not-help': `Restarting the server on ${params.appiumOrigin} did not help — a fresh one still could not serve this run, so the wedge is not the server alone: check adb itself (\`adb kill-server && adb devices\`) and that nothing else holds the port, then re-run.`
  };

  return advice[params.reason];
}
