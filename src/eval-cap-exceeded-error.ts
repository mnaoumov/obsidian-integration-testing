/**
 * @file
 *
 * The one error both transports raise when a single `evalInObsidian` closure
 * outruns the per-eval cap, and the predicate that recognizes the raw transport
 * error it replaces.
 *
 * The cap itself is not the problem this module solves — the diagnosis is.
 * Desktop surfaces the overrun as a generic
 * `CDP command timed out ... : Runtime.evaluate`, which never names the test's
 * own wait and so reads as a broken device or a wedged app — a plugin release was
 * once held for two days by that reading, with a healthy emulator blamed for
 * having no network.
 *
 * Android is worse, because it surfaces NOTHING. On a live emulator the closure
 * was measured completing in the guest on schedule — timers armed at 30s and 40s fired within
 * ~13ms of nominal on a visible, focused page — while its Execute Script response
 * never reached the client, so the call hung until whichever outer budget gave up
 * first. A hang names nothing at all, which is why the Android cap is enforced by
 * the transport on the Node side rather than by the `timeouts.script` capability
 * it also declares and that nothing acts on.
 *
 * Both transports therefore funnel into the message below, which says what the cap
 * is, which transport enforced it, and what to do instead.
 *
 * A closure that needs to wait longer than the cap should not be waiting inside
 * Obsidian at all. `pollInObsidian` is the sanctioned shape: short closures, and
 * the waiting done from Node.
 */

/*
 * The W3C error code is the spaced `script timeout`, while a client that turns it into a type spells the
 * Same thing as `ScriptTimeoutError` — hence the optional whitespace, which lets one pattern read both.
 */
const SCRIPT_TIMEOUT_PATTERN = /script\s*timeout/i;

/**
 * Parameters for {@link EvalCapExceededError}'s constructor.
 */
export interface EvalCapExceededErrorConstructorParams {
  /**
  The per-eval cap the closure outran, in milliseconds.
   */
  readonly capInMilliseconds: number;

  /**
  The underlying transport error, kept as the `cause` so the raw diagnosis is not lost.
   */
  readonly cause: unknown;

  /**
  The name of the option that sets the cap on this transport, so the message can name the real knob.
   */
  readonly optionName: string;

  /**
  How to refer to the transport that enforced the cap, e.g. `'Android (Appium)'`.
   */
  readonly transportName: string;
}

/**
 * Thrown when one `evalInObsidian` closure ran longer than the transport's
 * per-eval cap.
 *
 * Carries the cap and the transport so a caller can `instanceof`-match, and the
 * original transport error as `cause`.
 */
export class EvalCapExceededError extends Error {
  /**
  The per-eval cap the closure outran, in milliseconds.
   */
  public readonly capInMilliseconds: number;

  /**
  How the transport that enforced the cap was named in the message.
   */
  public readonly transportName: string;

  /**
   * Creates the error from the cap, the transport, and the raw error it replaces.
   *
   * @param params - The cap, the transport, the option that sets the cap, and the underlying error.
   */
  public constructor(params: EvalCapExceededErrorConstructorParams) {
    super(buildMessage(params), { cause: params.cause });
    this.name = 'EvalCapExceededError';
    this.capInMilliseconds = params.capInMilliseconds;
    this.transportName = params.transportName;
  }
}

/**
 * Whether an error is a WebDriver script timeout — the W3C error a driver would
 * raise if it enforced `timeouts.script`.
 *
 * Matched on the message rather than on a type, because the error arrives as a
 * generic `WebDriverError` whose only distinguishing mark is the W3C error code
 * in its text.
 *
 * **This driver never raises it.** UiAutomator2 was measured accepting the
 * capability, reporting it back, and enforcing nothing. The predicate is kept
 * because it costs nothing, it is the right translation if a future driver does
 * enforce the capability, and it keeps one error covering one condition on both
 * transports — but the Android cap is enforced Node-side, and this is not what
 * enforces it.
 *
 * @param error - The error thrown by the transport.
 * @returns `true` when the error is a script timeout.
 */
export function isScriptTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return SCRIPT_TIMEOUT_PATTERN.test(error.message) || SCRIPT_TIMEOUT_PATTERN.test(error.name);
}

/**
 * Builds the shared message both transports report.
 *
 * @param params - The cap, the transport, and the option that sets the cap.
 * @returns The message.
 */
function buildMessage(params: EvalCapExceededErrorConstructorParams): string {
  return `A single evalInObsidian closure ran longer than the ${params.transportName} per-eval cap of ${String(params.capInMilliseconds)}ms, so it was killed mid-flight. This is a property of the closure, not of the device or the app: `
    + 'everything awaited inside one closure shares that one budget, including every `lib.waitUntil` timeout '
    + 'and every settle `sleep`. Do the waiting from Node instead — `pollInObsidian` runs a short `poll` '
    + 'closure repeatedly until a Node-side `until` accepts, so no single eval is ever long. Raise '
    + `\`${params.optionName}\` only for a closure that genuinely cannot be split.`;
}
