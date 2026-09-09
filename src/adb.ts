/**
 * @file
 *
 * Runs `adb` and hands back what it printed — as text, or as raw bytes.
 *
 * The harness already shells out to `adb` in half a dozen places inside
 * `transport-factory` / `transport-appium`, but always through `exec`, which
 * decodes stdout as UTF-8. That is fine for `devices` and `settings get` and
 * fatally wrong for `exec-out screencap -p`, whose stdout is a PNG: decoding it
 * as text corrupts every byte above 0x7F. Hence the two runners here — the same
 * command shape, differing only in whether the output is decoded.
 *
 * These are the process layer for the device-facing helpers a capture suite
 * uses (`device-screenshot`, `device-settings`, `soft-keyboard`); they are not a
 * general-purpose adb wrapper and deliberately do not try to become one.
 *
 * Every function here shells out, so the whole module is integration-time code.
 * That is also why the parsing and geometry these helpers depend on live in
 * their own modules — the same split `adb-device-list` already has from the
 * transport factory, so a sort rule can never move a unit-tested function
 * inside a coverage-ignored block.
 */

/* v8 ignore start -- Integration-time code (shells out to a real device) covered by integration tests, not unit tests. */

import { execFile } from 'node:child_process';

/**
 * Parameters for {@link runAdbBinary} and {@link runAdbText}.
 */
export interface RunAdbParams {
  /**
   * The arguments to pass after `-s <deviceId>`, e.g. `['shell', 'input', 'tap', '10', '20']`.
   */
  readonly commandArguments: readonly string[];

  /**
   * The device to address, as `adb devices` lists it.
   */
  readonly deviceId: string;
}

/**
 * A screencap of a 900x1600 device runs to about 100 KB, but a tablet AVD's framebuffer is several MB and
 * the default 1 MiB `maxBuffer` fails the call rather than returning a usable image.
 */
const OUTPUT_MAX_BUFFER_IN_BYTES = 67_108_864;

/**
 * Runs `adb -s <deviceId> <commandArguments>` and returns stdout **undecoded**.
 *
 * @param params - The device and the arguments to run.
 * @returns A {@link Promise} that resolves to the raw stdout bytes.
 * @throws Error if adb could not be run, or exited non-zero.
 */
export async function runAdbBinary(params: RunAdbParams): Promise<Uint8Array> {
  const commandArguments = ['-s', params.deviceId, ...params.commandArguments];

  return await new Promise((resolve, reject) => {
    execFile('adb', commandArguments, { encoding: 'buffer', maxBuffer: OUTPUT_MAX_BUFFER_IN_BYTES }, (error, stdout) => {
      if (error) {
        reject(new Error(`Failed to run 'adb ${commandArguments.join(' ')}': ${error.message}. Is ADB installed and in PATH?`));
        return;
      }

      resolve(stdout);
    });
  });
}

/**
 * Runs `adb -s <deviceId> <commandArguments>` and returns stdout as trimmed text.
 *
 * @param params - The device and the arguments to run.
 * @returns A {@link Promise} that resolves to stdout, with surrounding whitespace removed.
 * @throws Error if adb could not be run, or exited non-zero.
 */
export async function runAdbText(params: RunAdbParams): Promise<string> {
  const stdout = await runAdbBinary(params);
  return new TextDecoder().decode(stdout).trim();
}

/**
 * Runs `adb <commandArguments>` with no device selected.
 *
 * Only `devices` needs this — every other call in this family addresses one device.
 *
 * @param commandArguments - The arguments to run.
 * @returns A {@link Promise} that resolves to stdout, with surrounding whitespace removed.
 * @throws Error if adb could not be run, or exited non-zero.
 */
export async function runAdbTextWithoutDevice(commandArguments: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile('adb', [...commandArguments], { encoding: 'utf-8', maxBuffer: OUTPUT_MAX_BUFFER_IN_BYTES }, (error, stdout) => {
      if (error) {
        reject(new Error(`Failed to run 'adb ${commandArguments.join(' ')}': ${error.message}. Is ADB installed and in PATH?`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

/* v8 ignore stop */
