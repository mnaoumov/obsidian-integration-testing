/**
 * @file
 *
 * The per-eval cap: how long a single `evalInObsidian` closure may run before
 * the transport carrying it gives up.
 *
 * It lives in its own module, and is re-exported from the package root, because
 * it is the single most load-bearing number a test author has to respect — and
 * until this module existed there was nothing to import. Both transports held
 * the same 30s privately, so every consumer that needed to size a closure
 * restated it as a literal with a comment saying where the number came from.
 * That is a mirror nothing maintains: raise a cap here and every restatement is
 * silently wrong in the direction that produces the unreadable failure, because
 * the consumer goes on believing it has headroom it no longer has.
 *
 * **The two transports share this ONE constant rather than agreeing by
 * coincidence.** They enforce it through different knobs — desktop bounds the
 * `Runtime.evaluate` CDP command (`commandTimeoutInMilliseconds`), Android
 * bounds the Execute Script call Node-side (`scriptTimeoutInMilliseconds`) —
 * but the knobs are two implementations of one policy, not two policies that
 * happen to agree. A reader of either default now sees which it is.
 */

/**
 * The default per-eval cap, in milliseconds: the budget one `evalInObsidian`
 * closure has to fit inside.
 *
 * Everything awaited inside a single closure shares this one budget — every
 * `lib.waitUntil` timeout and every settle `sleep` — so a closure's declared
 * waits have to sum to less than this, not merely be individually shorter.
 *
 * An overrun is reported as `EvalCapExceededError`, which names the cap, the
 * transport that enforced it, and the option that sets it. Raising that option
 * is almost never the right answer: a closure that needs to wait longer than
 * this should not be waiting inside Obsidian at all. `pollInObsidian` is the
 * sanctioned shape — short closures, with the waiting done from Node — and it
 * exists precisely so no single eval is ever long.
 *
 * Both transports default to this value: it is what
 * `ObsidianCdpTransportOptions.commandTimeoutInMilliseconds` and
 * `ObsidianAndroidAppiumTransportOptions.scriptTimeoutInMilliseconds` fall back
 * to when they are omitted.
 */
export const DEFAULT_EVAL_CAP_IN_MILLISECONDS = 30_000;
