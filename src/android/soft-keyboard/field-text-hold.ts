/**
 * @file
 *
 * Holds a scripted write to a field until it stays put.
 *
 * `raiseSoftKeyboard` empties its field for the touch that raises the IME and writes the text back afterwards.
 * The write lands, and then about one time in five it is undone: the touch started the IME's input connection
 * from the EMPTY field, and a later update from that connection writes the empty state back over the harness's
 * write. Nothing reports it — the capture taken straight after simply shows the placeholder — so the write is
 * not done until repeated reads agree it held.
 *
 * The loop is pure, with the read, the write and the sleep injected, the same split as `poll-until`: the
 * orchestration is unit-tested here, and only its wiring to a live renderer sits in the integration-only
 * `soft-keyboard`.
 */

/**
 * Parameters for {@link holdFieldText}.
 */
export interface HoldFieldTextParams {
  /**
   * How many consecutive reads must show the text before it counts as held.
   *
   * @default 3
   */
  readonly confirmationReadCount?: number;

  /**
   * The text the field must end up holding.
   */
  readonly expectedText: string;

  /**
   * The wait before each read.
   *
   * @default 300
   */
  readonly intervalInMilliseconds?: number;

  /**
   * How many writes are made in all, the first included, before the text is reported lost.
   *
   * @default 4
   */
  readonly maxWriteCount?: number;

  /**
   * Reads what the field holds now, or `null` when the field is gone.
   */
  readonly readText: (this: void) => Promise<null | string>;

  /**
   * Sleeps for the given number of milliseconds.
   */
  readonly sleep: (this: void, milliseconds: number) => Promise<void>;

  /**
   * Writes the text into the field.
   */
  readonly writeText: (this: void, text: string) => Promise<void>;
}

/**
 * What {@link holdFieldText} found.
 */
export interface HoldFieldTextResult {
  /**
   * Whether the text held for the whole confirmation window.
   */
  readonly isHeld: boolean;

  /**
   * Every read, in order — the evidence a failure reports.
   */
  readonly readTexts: readonly (null | string)[];

  /**
   * How many writes were made, the first included. Above one means the text was lost and written again.
   */
  readonly writeCount: number;
}

const DEFAULT_CONFIRMATION_READ_COUNT = 3;
const DEFAULT_INTERVAL_IN_MILLISECONDS = 300;
const DEFAULT_MAX_WRITE_COUNT = 4;

/**
 * Writes the text, then re-reads the field until it has shown the text on enough consecutive reads, writing it
 * again each time a read shows anything else.
 *
 * A read of `null` ends the hold at once, as not held: the field is gone, so there is nothing left to write into.
 *
 * @param params - The text, how to read and write the field, and how long it must hold.
 * @returns A {@link Promise} that resolves to whether the text held, every read, and how many writes it took.
 */
export async function holdFieldText(params: HoldFieldTextParams): Promise<HoldFieldTextResult> {
  const confirmationReadCount = params.confirmationReadCount ?? DEFAULT_CONFIRMATION_READ_COUNT;
  const intervalInMilliseconds = params.intervalInMilliseconds ?? DEFAULT_INTERVAL_IN_MILLISECONDS;
  const maxWriteCount = params.maxWriteCount ?? DEFAULT_MAX_WRITE_COUNT;
  const readTexts: (null | string)[] = [];

  await params.writeText(params.expectedText);
  let writeCount = 1;
  let agreeingReadCount = 0;

  while (agreeingReadCount < confirmationReadCount) {
    await params.sleep(intervalInMilliseconds);
    const text = await params.readText();
    readTexts.push(text);

    if (text === params.expectedText) {
      agreeingReadCount++;
      continue;
    }

    if (text === null || writeCount >= maxWriteCount) {
      return { isHeld: false, readTexts, writeCount };
    }

    await params.writeText(params.expectedText);
    writeCount++;
    agreeingReadCount = 0;
  }

  return { isHeld: true, readTexts, writeCount };
}
