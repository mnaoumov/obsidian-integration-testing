/**
 * @file
 *
 * Pure classification of whether the device a run is about to drive is still
 * **there** — and, when it is not, which of the two very different things went
 * wrong: the guest froze, or the emulator process itself did.
 *
 * The readiness gates in `device-readiness.ts` answer *"is the guest ready
 * yet?"*, and both are deliberately best-effort: they warn and proceed. Nothing
 * asked *"is it still answering?"* at the moment the session is created, so a
 * guest that stopped answering between the last gate and `remote()` was handed
 * to Appium anyway. What the operator then saw was Appium's own report:
 *
 * ```text
 * WebDriverError: Device emulator-5554 was not in the list of connected devices
 *   when running "http://localhost:4723/session" with method "POST"
 * ```
 *
 * — measured on this host 2026-09-05, after 515s. That names the device, and
 * `adb devices` then lists the device happily, so it sends the reader to the one
 * diagnostic that cannot help. The same trap `wedged-appium-server.ts` exists to
 * escape, one layer further down.
 *
 * ## The console is what tells the two apart
 *
 * `adb -s <device> emu <command>` is served by the **emulator's own console**,
 * not by the guest's `adbd`. So the two probes answer different questions, and
 * the pair is a diagnosis where either alone is a guess:
 *
 * | `adb shell` | `adb emu` | What it means |
 * | --- | --- | --- |
 * | answers | — | Alive. Proceed. |
 * | silent | answers | The **guest** is frozen or too busy to schedule `adbd`. |
 * | silent | silent | The **emulator process** is wedged. Nothing will recover it. |
 *
 * Measured 2026-09-05 across six hand-boots on this host — two AVDs and five
 * argument sets — every one of which reached the bottom row 64–92s after boot:
 *
 * ```text
 * 80s  emulator console (QEMU, not the guest): HUNG
 * 80s  qemu-system-x86_64-headless (pid 10004): cpu=0% rss=5.82GB
 * ```
 *
 * **0% CPU** — blocked, not spinning — and a console that cannot answer. That is
 * the QEMU main loop, below anything the guest, the GPU stack, the network
 * simulator or the AVD's size can explain (each was eliminated by measurement,
 * not by argument). It also explains the two downstream symptoms that had always
 * looked like separate faults: `adb devices` keeps reporting `device` because
 * nothing is left running to update that state, and the teardown's
 * `adb emu kill` hangs for its full budget because it is asking the wedged
 * console to shut itself down.
 *
 * The harness already *observed* the second half of this — teardown logs
 * `Emulator console shutdown for emulator-5554 did not answer` — but only after
 * the run had already failed with an error blaming the device. This module moves
 * that observation to where it changes the verdict instead of annotating it.
 *
 * Kept separate from the integration-only `transport-factory` (excluded from
 * unit tests) so the classification and the message stay unit-testable — the
 * factory itself shells out to `adb`.
 */

import { checkIsEmulatorDeviceId } from './avd-probe-verdict.ts';
import { appendProcessOutputTail } from './process-exit-message.ts';

/**
 * Parameters for {@link buildEmulatorLivenessMessage}.
 */
export interface BuildEmulatorLivenessMessageParams {
  /**
  The device the run was about to drive.
   */
  readonly deviceId: string;

  /**
  The emulator's captured stdout+stderr tail, when this run started it (empty when none).
   */
  readonly emulatorOutput: string;

  /**
  The per-probe budget, so the message states what "did not answer" was measured against.
   */
  readonly probeTimeoutInMilliseconds: number;

  /**
  Which failure this is. `'alive'` is not a failure and has no message.
   */
  readonly verdict: Exclude<EmulatorLivenessVerdict, 'alive'>;
}

/**
 * What one probe of the device answered.
 *
 * `'errored'` is an **answer** — something responded, with a refusal. Only
 * `'no-answer'` is silence, the distinction `avd-probe-verdict.ts` was written
 * to preserve and the one this module turns into a verdict.
 */
export type EmulatorLivenessProbeOutcome = 'answered' | 'errored' | 'no-answer';

/**
 * Whether the device is still usable, and if not, which layer failed.
 *
 * - `'alive'` — the guest answered. Proceed.
 * - `'device-gone'` — the host's adb no longer lists it at all.
 * - `'emulator-wedged'` — neither the guest nor the emulator's own console
 *   answers. The emulator process is stuck; retrying anything against this
 *   device cannot succeed.
 * - `'guest-unresponsive'` — the console answers but the guest does not, so the
 *   emulator is alive and the guest is frozen or starved.
 */
export type EmulatorLivenessVerdict = 'alive' | 'device-gone' | 'emulator-wedged' | 'guest-unresponsive';

/**
 * Parameters for {@link resolveEmulatorLivenessVerdict}.
 */
export interface ResolveEmulatorLivenessVerdictParams {
  /**
   * What `adb -s <device> emu avd status` answered — the **emulator console**,
   * served by the emulator process rather than by the guest.
   *
   * Meaningful only for an `emulator-<port>` device: the console errors against
   * a physical handset however healthy it is, which is why a non-emulator is
   * never convicted on it (the trap `avd-probe-verdict.ts` documents).
   */
  readonly consoleProbe: EmulatorLivenessProbeOutcome;

  /**
  The device the run is about to drive.
   */
  readonly deviceId: string;

  /**
  Whether the host's `adb devices` still lists the device in any state.
   */
  readonly isListedByAdb: boolean;

  /**
  What `adb -s <device> shell true` answered — the **guest**, via `adbd`.
   */
  readonly shellProbe: EmulatorLivenessProbeOutcome;
}

/**
 * Builds the message for a device that stopped answering, naming the layer that
 * failed and the evidence for it.
 *
 * @param params - The verdict, the device, the probe budget and the emulator's output.
 * @returns The message.
 */
export function buildEmulatorLivenessMessage(params: BuildEmulatorLivenessMessageParams): string {
  const budget = `${String(params.probeTimeoutInMilliseconds)}ms`;

  /*
   * A `Record` keyed by the verdict rather than a `switch`: exhaustiveness comes
   * from the type, with no unreachable `default` arm to explain or to cover.
   * Same shape as `resolveRemedyAdvice` in `wedged-appium-server.ts`.
   */
  const diagnosis: Record<Exclude<EmulatorLivenessVerdict, 'alive'>, string[]> = {
    'device-gone': [
      'The host\'s `adb devices` no longer lists it, so it is no longer serving adb at all.',
      'Either the emulator exited, or it wedged badly enough to drop off adb — the emulator output below is the best evidence for which.',
      'Re-run to boot a fresh one, and check that nothing else on this host stops emulators.'
    ],
    'emulator-wedged': [
      `Neither the guest (\`adb -s ${params.deviceId} shell\`) nor the emulator's own console (\`adb -s ${params.deviceId} emu avd status\`) answered within ${budget}.`,
      'The console is served by the emulator process, not by the guest, so its silence means the EMULATOR is wedged — not the guest, not the Appium server, and not the device being absent.',
      '`adb devices` will still list this device and will mislead you: nothing is left running to update that state.',
      'This run cannot recover it. A wedged emulator does not come back, so retrying the session against it cannot succeed; the emulator is torn down instead, and a re-run boots a fresh one.',
      'If it recurs at the same point in every run, the fault is below the harness: check the emulator build, the system image and the host hypervisor rather than these tests.'
    ],
    'guest-unresponsive': [
      `The guest (\`adb -s ${params.deviceId} shell\`) did not answer within ${budget}, but the emulator's own console did.`,
      'So the emulator process is healthy and the guest is frozen or too starved to schedule `adbd`.',
      'A contended host is the usual cause; `deviceIdleTimeoutInMilliseconds` is the budget that governs waiting one out.'
    ]
  };

  const lines = [
    `Device ${params.deviceId} stopped answering before the Appium session could be established.`,
    ...diagnosis[params.verdict]
  ];

  return appendProcessOutputTail(lines.join('\n'), { output: params.emulatorOutput, outputLabel: 'Emulator output' });
}

/**
 * Decides whether the device is still usable, and which layer failed when it is
 * not.
 *
 * A guest that answers settles it on its own — a console probe is only consulted
 * when the guest has already gone quiet, so a healthy run never pays for it.
 *
 * @param params - What each probe answered, and whether adb still lists the device.
 * @returns The verdict.
 */
export function resolveEmulatorLivenessVerdict(params: ResolveEmulatorLivenessVerdictParams): EmulatorLivenessVerdict {
  /*
   * The two probes are read asymmetrically, deliberately. Only `'answered'`
   * clears the guest, because an `errored` shell is adb's own refusal
   * (`adb.exe: device offline`) rather than the guest speaking — it is not
   * evidence of life. Only `'no-answer'` convicts the emulator, because an
   * errored console *is* the emulator speaking, and a live process that refuses
   * a command is not a wedged one. Each probe is trusted in the direction it can
   * actually testify.
   */
  if (params.shellProbe === 'answered') {
    return 'alive';
  }

  if (!params.isListedByAdb) {
    return 'device-gone';
  }

  /*
   * `adb … emu` errors against a physical handset however healthy it is, so its
   * silence is not evidence there. Only an `emulator-<port>` device has a
   * console whose silence can convict it — the same restraint `classifyAvdProbe`
   * shows in never probing a non-emulator at all.
   */
  if (!checkIsEmulatorDeviceId(params.deviceId)) {
    return 'guest-unresponsive';
  }

  return params.consoleProbe === 'no-answer' ? 'emulator-wedged' : 'guest-unresponsive';
}
