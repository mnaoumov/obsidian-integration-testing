/**
 * @file
 *
 * The channels a run can ask *"which AVD is this device serving?"*, and the
 * order to ask them in.
 *
 * **L47** made the adoption probe refuse rather than collide when a device did
 * not answer. It asked that question over the emulator's **console** — a second
 * TCP port, with its own auth token and its own ways of wedging, entirely
 * separate from the `adbd` channel every other call in the run travels. So a
 * single emulator whose console is wedged — routinely **another project's**,
 * with the bulk runner sweeping several projects at once — took every Obsidian
 * Android suite on the machine out of service:
 *
 * ```text
 * [transport-factory:obsidian-android-appium] AVD probe: emulator-5570=no-answer.
 * Error: AVD "obsidian_test": device emulator-5570 did not answer `adb -s emulator-5570 emu avd name` ...
 * ```
 *
 * `adb devices` listed `emulator-5570` as `device` and adb itself was perfectly
 * responsive throughout; only its console was gone. The refusal was right —
 * launching a second copy of an AVD hits `FATAL | Running multiple emulators
 * with the same AVD is an experimental feature` — but it was keyed on the one
 * channel the run does **not** otherwise depend on.
 *
 * The AVD name is also a guest system property, readable over the same `adbd`
 * channel the run needs anyway, so it cannot be wedged independently of the
 * connection the run is about to use:
 *
 * ```text
 * adb -s <device> shell getprop ro.boot.qemu.avd_name     # modern images
 * adb -s <device> shell getprop ro.kernel.qemu.avd_name   # older images
 * ```
 *
 * Hence this ordering: property first, console only as a fallback for an image
 * that reports neither. The hard refusal stays for the genuinely-unknowable
 * device — a silent one may well be the AVD's holder — it is simply reached far
 * less often.
 *
 * **A dead channel is not asked twice.** When the `adb shell` call itself fails
 * or times out, the second property key is skipped: it travels the same channel
 * that has just proved unusable, and would only spend another full timeout to
 * learn the same thing. An *answered* but empty property is the opposite — the
 * channel is alive and the image simply does not carry that key — so the
 * cheaper sibling key is worth asking. That distinction is what keeps a wedged
 * device's worst case at two timeouts per attempt rather than three.
 *
 * Pure and unit-tested; the `adb` round-trips live in `transport-factory` and
 * `resolve-emulator-device-id`, which are integration-time code.
 */

import { assertNever } from './type-guards.ts';

/**
 * One way of asking a device which AVD it was started from.
 *
 * `getprop-boot` and `getprop-kernel` travel `adbd` — the channel the run
 * depends on anyway; `console` is the emulator's own TCP console, which can
 * wedge on its own.
 */
export type AvdNameChannel = 'console' | 'getprop-boot' | 'getprop-kernel';

/**
 * What one channel answered.
 *
 * The two fields are deliberately independent: a channel can respond and report
 * **nothing** (an image without that property), which is a fact about the
 * image, while a channel that did not respond is a fact about the channel.
 * Collapsing them is the defect **L47** fixed one level up.
 */
export interface AvdNameChannelAnswer {
  /**
  Whether the command itself completed — regardless of what it reported.
   */
  readonly didRespond: boolean;

  /**
  The AVD name it reported, or `''` when it reported none.
   */
  readonly reportedAvdName: string;
}

/**
 * Parameters for {@link buildAvdNameChannelArguments}.
 */
export interface BuildAvdNameChannelArgumentsParams {
  /**
  The channel to ask.
   */
  readonly channel: AvdNameChannel;

  /**
  The device to address, or a placeholder such as `<device>` when building a message about several.
   */
  readonly deviceId: string;
}

/**
 * Parameters for {@link resolveNextAvdNameChannel}.
 */
export interface ResolveNextAvdNameChannelParams {
  /**
  The channel that was just asked.
   */
  readonly channel: AvdNameChannel;

  /**
  Whether that channel's command completed at all.
   */
  readonly didChannelRespond: boolean;
}

/**
 * The channel a probe starts with: the guest property, over `adbd`.
 */
export const FIRST_AVD_NAME_CHANNEL: AvdNameChannel = 'getprop-boot';

/**
 * The system property each `getprop` channel reads.
 *
 * `ro.boot.qemu.avd_name` is what current system images carry;
 * `ro.kernel.qemu.avd_name` is the older spelling, still present on images the
 * harness supports.
 */
const AVD_NAME_PROPERTY_BY_CHANNEL = {
  'getprop-boot': 'ro.boot.qemu.avd_name',
  'getprop-kernel': 'ro.kernel.qemu.avd_name'
} as const;

/**
 * Builds the `adb` arguments that ask one channel for the AVD name.
 *
 * @param params - The channel to ask and the device to address.
 * @returns The arguments to pass to `adb`, starting with `-s <deviceId>`.
 */
export function buildAvdNameChannelArguments(params: BuildAvdNameChannelArgumentsParams): string[] {
  return ['-s', params.deviceId, ...buildAvdNameChannelCommand(params.channel)];
}

/**
 * Builds the `adb` arguments that follow `-s <deviceId>`.
 *
 * Split from {@link buildAvdNameChannelArguments} because the two callers
 * address their device differently: `transport-factory` shells out to `adb`
 * itself, while `resolve-emulator-device-id` goes through `adb.ts`, which
 * prepends `-s <deviceId>` of its own.
 *
 * @param channel - The channel to ask.
 * @returns The command arguments, without any device selection.
 */
export function buildAvdNameChannelCommand(channel: AvdNameChannel): string[] {
  return channel === 'console' ? ['emu', 'avd', 'name'] : ['shell', 'getprop', AVD_NAME_PROPERTY_BY_CHANNEL[channel]];
}

/**
 * Renders `adb` arguments as the command line a reader can paste.
 *
 * Built from the arguments the run actually passes rather than written out a
 * second time, so a message can never quote a command the code does not run.
 *
 * @param commandArguments - The arguments passed to `adb`.
 * @returns The full command line.
 */
export function describeAdbCommand(commandArguments: readonly string[]): string {
  return `adb ${commandArguments.join(' ')}`;
}

/**
 * Reads the AVD name out of what a channel printed.
 *
 * Both channels answer on the first line — `getprop` prints the value (an empty
 * line when the property is unset), the console prints the name and then `OK`.
 *
 * @param stdout - What the command printed.
 * @returns The reported AVD name, or `''` when it reported none.
 */
export function parseAvdNameAnswer(stdout: string): string {
  /*
   * Sliced rather than an indexed read with a `?? ''` fallback: no input can
   * reach that fallback, and the per-file coverage gate then reports it as an
   * uncovered branch for the rest of the file's life.
   */
  const lineBreakIndex = stdout.indexOf('\n');
  const firstLine = lineBreakIndex === -1 ? stdout : stdout.slice(0, lineBreakIndex);

  return firstLine.trim();
}

/**
 * Picks the next channel to ask after one failed to identify the device.
 *
 * @param params - The channel just asked, and whether its command completed.
 * @returns The next channel, or `undefined` once every channel has been asked.
 */
export function resolveNextAvdNameChannel(params: ResolveNextAvdNameChannelParams): AvdNameChannel | undefined {
  switch (params.channel) {
    case 'console': {
      return undefined;
    }
    case 'getprop-boot': {
      /*
       * A `getprop` that never came back says the `adbd` channel is unusable,
       * so the sibling key — which travels that same channel — would only spend
       * another full timeout. A channel that answered nothing says only that
       * this image does not carry that key, which the sibling may well carry.
       */
      return params.didChannelRespond ? 'getprop-kernel' : 'console';
    }
    case 'getprop-kernel': {
      return 'console';
    }
    default: {
      return assertNever(params.channel);
    }
  }
}
