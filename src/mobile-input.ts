/**
 * @file
 *
 * Translates a mobile trusted-input request into the ordered Chrome DevTools Protocol `Input.*` commands
 * that realize it (see **L39**).
 *
 * Pure and synchronous by design: the WebView connection ({@link WebViewCdpConnection}) sends whatever this
 * returns, so every decision that is worth a test — the touch pair a tap expands into, the dwell a
 * long-press adds, the `rawKeyDown` → `char` → `keyUp` shape a key press mirrors from the desktop twin, the
 * modifier bitmask — lives here rather than inside the transport's I/O path.
 *
 * The request travels renderer → host as JSON (the renderer computes the coordinates, because only it can
 * see the DOM), so both the request and the command shapes are deliberately plain data.
 */

/**
 * The name of the `Runtime.addBinding` function the host exposes on the page so the renderer can hand it an
 * input request mid-closure.
 *
 * It is passed *into* the serialized bootstrap closure as data rather than referenced from it, because that
 * closure may not read outer scope (**L15**) — so this stays the single definition.
 */
export const MOBILE_INPUT_BINDING_NAME = '__obsidianIntegrationTestingInput';

/**
 * How long the renderer waits for the host to service one input request before giving up.
 *
 * Generous relative to the work (a tap is two CDP commands; a long-press adds a 600ms dwell): the point is
 * to fail with a legible error rather than hang the closure until the whole run times out. Passed into the
 * bootstrap closure as data, for the same reason as {@link MOBILE_INPUT_BINDING_NAME}.
 */
export const MOBILE_INPUT_TIMEOUT_IN_MILLISECONDS = 15_000;

/**
 * A single Chrome DevTools Protocol command, plus how long to wait before sending it.
 *
 * The delay is carried here rather than applied by the producer so that the whole sequence stays pure
 * data — a test asserts the dwell without waiting for it.
 */
export interface CdpInputCommand {
  /**
   * Milliseconds to wait before sending this command. Absent means "send immediately".
   *
   * Used only by the long-press dwell.
   */
  readonly delayBeforeInMilliseconds?: number;

  /**
   * The CDP method name, e.g. `Input.dispatchTouchEvent`.
   */
  readonly method: string;

  /**
   * The CDP method parameters.
   */
  readonly params: Record<string, unknown>;
}

/**
 * What the renderer hands to the host binding: one request, plus the id to answer it on.
 *
 * The renderer builds this literal inside the serialized bootstrap closure, which cannot import (**L15**),
 * so the shape is declared here and mirrored there. They are one wire format; change them together.
 */
export interface MobileInputEnvelope {
  /**
   * The request id the renderer is waiting on.
   */
  readonly id: string;

  /**
   * What to inject.
   */
  readonly request: MobileInputRequest;
}

/**
 * Anything the renderer can ask the host to inject.
 */
export type MobileInputRequest = MobileKeyInputRequest | MobilePointerInputRequest;

/**
 * A trusted key press to inject on mobile.
 */
export interface MobileKeyInputRequest {
  /**
   * The key to press, in the same spelling the desktop twin takes: either a named key
   * (`Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, an arrow) or a single printable character.
   */
  readonly key: string;

  /**
   * Discriminant.
   */
  readonly kind: 'key';

  /**
   * Modifiers already resolved to their platform-independent lowercase names by the renderer's
   * `toElectronModifiers` — the one mapping a key press and a click share, so `'Mod'` cannot mean two
   * different things (**L17**).
   */
  readonly modifiers: readonly string[];
}

/**
 * A trusted pointer gesture to inject on mobile, in CSS pixels within the WebView's own viewport.
 *
 * No device-pixel conversion is involved: CDP takes page coordinates, so `devicePixelRatio` and the
 * WebView's offset under the status bar never enter the picture (they would for native injection).
 */
export interface MobilePointerInputRequest {
  /**
   * `tap` is the touch analog of a left click; `longPress` is the mobile context-menu gesture, i.e. what a
   * desktop right click means here.
   */
  readonly kind: 'longPress' | 'tap';

  /**
   * See {@link MobileKeyInputRequest.modifiers}.
   */
  readonly modifiers: readonly string[];

  /**
   * The viewport x coordinate, in CSS pixels.
   */
  readonly x: number;

  /**
   * The viewport y coordinate, in CSS pixels.
   */
  readonly y: number;
}

/**
 * How long a long-press holds the touch down before releasing it.
 *
 * Obsidian Mobile implements long-press in JavaScript (a timer started on `touchstart`) rather than
 * relying on a native gesture, so this has to clear *its* threshold, not Android's. 600ms is the
 * conventional Android long-press threshold and clears Obsidian's comfortably.
 */
const LONG_PRESS_DWELL_IN_MILLISECONDS = 600;

const NO_MODIFIERS = 0;
const MODIFIER_BIT_ALT = 1;
const MODIFIER_BIT_CONTROL = 2;
const MODIFIER_BIT_META = 4;
const MODIFIER_BIT_SHIFT = 8;

/**
 * CDP's modifier bitmask, which is not the same spelling as Electron's string list.
 *
 * @see {@link https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent}
 */
const CDP_MODIFIER_BIT_BY_NAME = new Map<string, number>([
  ['alt', MODIFIER_BIT_ALT],
  ['control', MODIFIER_BIT_CONTROL],
  ['meta', MODIFIER_BIT_META],
  ['shift', MODIFIER_BIT_SHIFT]
]);

const KEY_CODE_BACKSPACE = 8;
const KEY_CODE_TAB = 9;
const KEY_CODE_ENTER = 13;
const KEY_CODE_ESCAPE = 27;
const KEY_CODE_ARROW_LEFT = 37;
const KEY_CODE_ARROW_UP = 38;
const KEY_CODE_ARROW_RIGHT = 39;
const KEY_CODE_ARROW_DOWN = 40;
const KEY_CODE_DELETE = 46;

/**
 * Named keys, with the `text` a real key press would produce (absent when it produces none).
 *
 * Only keys the fleet actually presses are listed, plus the editing keys a caller would reasonably reach
 * for next. An unknown multi-character key is a caller error, not a silent no-op — see
 * {@link toKeyCommands}.
 */
const NAMED_KEYS = new Map<string, NamedKey>([
  ['ArrowDown', { code: 'ArrowDown', windowsVirtualKeyCode: KEY_CODE_ARROW_DOWN }],
  ['ArrowLeft', { code: 'ArrowLeft', windowsVirtualKeyCode: KEY_CODE_ARROW_LEFT }],
  ['ArrowRight', { code: 'ArrowRight', windowsVirtualKeyCode: KEY_CODE_ARROW_RIGHT }],
  ['ArrowUp', { code: 'ArrowUp', windowsVirtualKeyCode: KEY_CODE_ARROW_UP }],
  ['Backspace', { code: 'Backspace', windowsVirtualKeyCode: KEY_CODE_BACKSPACE }],
  ['Delete', { code: 'Delete', windowsVirtualKeyCode: KEY_CODE_DELETE }],
  ['Enter', { code: 'Enter', text: '\r', windowsVirtualKeyCode: KEY_CODE_ENTER }],
  ['Escape', { code: 'Escape', windowsVirtualKeyCode: KEY_CODE_ESCAPE }],
  ['Tab', { code: 'Tab', text: '\t', windowsVirtualKeyCode: KEY_CODE_TAB }]
]);

const FIRST_CODE_POINT_INDEX = 0;
const NO_CODE_POINT = 0;
const DIGIT_ZERO_CODE_POINT = '0'.codePointAt(FIRST_CODE_POINT_INDEX) ?? NO_CODE_POINT;
const DIGIT_NINE_CODE_POINT = '9'.codePointAt(FIRST_CODE_POINT_INDEX) ?? NO_CODE_POINT;
const UPPERCASE_A_CODE_POINT = 'A'.codePointAt(FIRST_CODE_POINT_INDEX) ?? NO_CODE_POINT;
const UPPERCASE_Z_CODE_POINT = 'Z'.codePointAt(FIRST_CODE_POINT_INDEX) ?? NO_CODE_POINT;

/**
 * The CDP spelling of one named key.
 */
interface NamedKey {
  readonly code: string;
  readonly text?: string;
  readonly windowsVirtualKeyCode: number;
}

/**
 * Builds the expression the host evaluates to answer one input request.
 *
 * Optional chaining throughout: by the time the host answers, the page may have navigated and dropped the
 * namespace, and a `TypeError` inside this evaluate would be reported as an injection failure that already
 * succeeded.
 *
 * @param id - The request id the renderer is waiting on.
 * @param errorMessage - Why the injection failed, when it did. Omit on success.
 * @returns A self-contained expression to pass to `Runtime.evaluate`.
 */
export function buildResolveInputExpression(id: string, errorMessage?: string): string {
  return `window.__obsidianIntegrationTesting?.resolveInput?.(${JSON.stringify(id)}, ${JSON.stringify(errorMessage ?? null)})`;
}

/**
 * Translates a mobile input request into the ordered CDP commands that realize it.
 *
 * @param request - What the renderer asked the host to inject.
 * @returns The commands to send, in order.
 */
export function toCdpInputCommands(request: MobileInputRequest): CdpInputCommand[] {
  if (request.kind === 'key') {
    return toKeyCommands(request);
  }

  return toPointerCommands(request);
}

/**
 * Folds resolved modifier names into CDP's bitmask.
 *
 * Unknown names are ignored rather than throwing: the renderer's `toElectronModifiers` is exhaustive over
 * Obsidian's `Modifier` union, so an unknown name here would mean the two copies have already drifted, and
 * failing the whole gesture is a worse outcome than pressing it unmodified.
 *
 * @param modifiers - Resolved lowercase modifier names.
 * @returns The CDP modifier bitmask.
 */
export function toCdpModifiers(modifiers: readonly string[]): number {
  // Summing DISTINCT bits equals OR-ing them, and the `Set` is what makes that hold even when a caller
  // Passes the same modifier twice — so the mask is built without a bitwise operator.
  const bits = new Set<number>();
  for (const modifier of modifiers) {
    const bit = CDP_MODIFIER_BIT_BY_NAME.get(modifier);
    if (bit !== undefined) {
      bits.add(bit);
    }
  }

  let bitmask = NO_MODIFIERS;
  for (const bit of bits) {
    bitmask += bit;
  }

  return bitmask;
}

/**
 * Resolves a key name to its CDP spelling.
 *
 * @param key - A named key or a single printable character.
 * @returns The CDP spelling.
 */
function resolveKey(key: string): NamedKey {
  const namedKey = NAMED_KEYS.get(key);
  if (namedKey) {
    return namedKey;
  }

  // "Exactly one code point", tested without splitting the string: `fromCodePoint` round-trips only when
  // `key` is that single code point, so an astral-plane character counts as one and `'Ctrl+K'` does not.
  const codePoint = key.codePointAt(FIRST_CODE_POINT_INDEX);
  if (codePoint === undefined || String.fromCodePoint(codePoint) !== key) {
    throw new Error(
      `pressKey received an unknown key name on mobile: ${JSON.stringify(key)}. `
        + `Pass a single character or one of: ${[...NAMED_KEYS.keys()].join(', ')}.`
    );
  }

  const upperCasedCodePoint = key.toUpperCase().codePointAt(FIRST_CODE_POINT_INDEX) ?? codePoint;
  return {
    code: resolveKeyCode(upperCasedCodePoint),
    text: key,
    windowsVirtualKeyCode: upperCasedCodePoint
  };
}

/**
 * Resolves the physical `code` for a printable character.
 *
 * Characters outside the ASCII letter/digit rows have no stable physical key, so they get an empty
 * `code` — the `text` still carries them, which is what an editor reads.
 *
 * @param upperCasedCodePoint - The character's upper-cased code point.
 * @returns The CDP `code`, or an empty string when there is no stable one.
 */
function resolveKeyCode(upperCasedCodePoint: number): string {
  if (upperCasedCodePoint >= UPPERCASE_A_CODE_POINT && upperCasedCodePoint <= UPPERCASE_Z_CODE_POINT) {
    return `Key${String.fromCodePoint(upperCasedCodePoint)}`;
  }

  if (upperCasedCodePoint >= DIGIT_ZERO_CODE_POINT && upperCasedCodePoint <= DIGIT_NINE_CODE_POINT) {
    return `Digit${String.fromCodePoint(upperCasedCodePoint)}`;
  }

  return '';
}

/**
 * Builds the command sequence for a key press.
 *
 * Mirrors the desktop twin's trusted `keyDown` → `char` → `keyUp` in CDP's spelling: `rawKeyDown` fires
 * `keydown` alone, `char` fires `keypress` / `beforeinput` / `input`, `keyUp` fires `keyup`. A key that
 * produces no text (`Escape`) skips the `char`, exactly as a real one does.
 *
 * @param request - The key request.
 * @returns The commands to send, in order.
 */
function toKeyCommands(request: MobileKeyInputRequest): CdpInputCommand[] {
  const { code, text, windowsVirtualKeyCode } = resolveKey(request.key);
  const modifiers = toCdpModifiers(request.modifiers);
  const base = { code, key: request.key, modifiers, windowsVirtualKeyCode };

  const commands: CdpInputCommand[] = [
    { method: 'Input.dispatchKeyEvent', params: { ...base, type: 'rawKeyDown' } }
  ];

  if (text !== undefined) {
    commands.push({ method: 'Input.dispatchKeyEvent', params: { ...base, text, type: 'char' } });
  }

  commands.push({ method: 'Input.dispatchKeyEvent', params: { ...base, type: 'keyUp' } });

  return commands;
}

/**
 * Builds the command sequence for a tap or a long-press.
 *
 * A trusted touch pair is all Chromium needs — it synthesizes `pointerdown` / `touchstart` /
 * `pointerup` / `touchend` / `click` from it, every one `isTrusted`. The release carries an empty
 * `touchPoints` list, which is CDP's spelling for "all fingers lifted".
 *
 * @param request - The pointer request.
 * @returns The commands to send, in order.
 */
function toPointerCommands(request: MobilePointerInputRequest): CdpInputCommand[] {
  const modifiers = toCdpModifiers(request.modifiers);

  return [
    {
      method: 'Input.dispatchTouchEvent',
      params: { modifiers, touchPoints: [{ x: request.x, y: request.y }], type: 'touchStart' }
    },
    {
      ...(request.kind === 'longPress' && { delayBeforeInMilliseconds: LONG_PRESS_DWELL_IN_MILLISECONDS }),
      method: 'Input.dispatchTouchEvent',
      params: { modifiers, touchPoints: [], type: 'touchEnd' }
    }
  ];
}
