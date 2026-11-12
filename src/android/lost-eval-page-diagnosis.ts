/**
 * @file
 *
 * Says what happened to the WebView page when an Android evaluation came back with no result (AGENTS.md L90).
 *
 * The harness's `evalWrapper` always answers with a JSON envelope, so an Execute Script that returns
 * `null` means the page that ran the closure went away before it answered. The transport then asks the
 * page that is there NOW how old it is and whether it carries the harness namespace, and reads the
 * device log for a renderer that died. A page younger than the time since the eval started was loaded
 * during it, which is a replacement; the guest's own `performance.now()` is used for the age, so no
 * host-guest clock comparison is involved.
 */

/**
 * Parameters for {@link describeLostEvalPage}.
 */
export interface DescribeLostEvalPageParams {
  /**
   * The device log lines that name a renderer or app process going away, newest last.
   */
  readonly logLines: readonly string[];

  /**
   * The page state the probe read, or `null` when the probe failed.
   */
  readonly pageState: LostEvalPageState | null;

  /**
   * Why the probe failed, when it did.
   */
  readonly probeError?: string;

  /**
   * Host time from the start of the lost evaluation to the end of the probe.
   */
  readonly sinceEvalStartInMilliseconds: number;
}

/**
 * What the probe read from the page the WebView shows after the result was lost.
 */
export interface LostEvalPageState {
  /**
   * Whether `window.__obsidianIntegrationTesting` exists. A fresh page has no namespace until the harness bootstraps it.
   */
  readonly hasNamespace: boolean;

  /**
   * The page's URL.
   */
  readonly href: string;

  /**
   * Whether `app.workspace.layoutReady` is true on the page.
   */
  readonly isLayoutReady: boolean;

  /**
   * How long ago the page was loaded, by its own `performance.now()`.
   */
  readonly pageAgeInMilliseconds: number;

  /**
   * The page's `document.readyState`.
   */
  readonly readyState: string;
}

/**
 * The expression the transport evaluates to read {@link LostEvalPageState}. It returns a JSON string.
 */
export const LOST_EVAL_PAGE_STATE_PROBE_EXPRESSION = 'JSON.stringify({'
  + 'hasNamespace: typeof window.__obsidianIntegrationTesting === "object" && window.__obsidianIntegrationTesting !== null, '
  + 'href: String(location.href), '
  + 'isLayoutReady: Boolean(window.app && window.app.workspace && window.app.workspace.layoutReady), '
  + 'pageAgeInMilliseconds: Math.round(performance.now()), '
  + 'readyState: String(document.readyState)'
  + '})';

/**
 * The most device log lines a diagnosis quotes.
 */
const MAX_LOG_LINES = 8;

/**
 * Device log lines that name a renderer, the WebView or the app's process going away.
 */
const PAGE_REPLACEMENT_LOG_LINE_PATTERN = /RenderProcessGone|render(?:er)? process (?:crash|gone|exit|died)|crashed.*renderer|cr_.*(?:crash|killed)|chromium.*FATAL|lowmemorykiller|lmkd.*md\.obsidian|Process md\.obsidian.*(?:died|has died)|Kill(?:ing)? .*md\.obsidian|md\.obsidian.*(?:crash|ANR)/iu;

/**
 * Says what happened to the page, from what the probe and the device log found.
 *
 * @param params - The probe's answer, the time since the eval started and the device log lines.
 * @returns One paragraph for the error message.
 */
export function describeLostEvalPage(params: DescribeLostEvalPageParams): string {
  const { logLines, pageState, probeError, sinceEvalStartInMilliseconds } = params;
  const parts: string[] = [];

  if (pageState === null) {
    parts.push(`The WebView could not be asked what page it shows now${probeError === undefined ? '' : `: ${probeError}`}.`);
  } else {
    const pageSummary = `${pageState.href} (readyState ${pageState.readyState}, layout ${pageState.isLayoutReady ? 'ready' : 'not ready'}, `
      + `harness namespace ${pageState.hasNamespace ? 'present' : 'absent'})`;
    if (pageState.pageAgeInMilliseconds < sinceEvalStartInMilliseconds) {
      parts.push(
        `The page was REPLACED while the closure ran: the WebView now shows a page loaded ${String(pageState.pageAgeInMilliseconds)}ms ago, `
          + `${String(sinceEvalStartInMilliseconds - pageState.pageAgeInMilliseconds)}ms after the eval started: ${pageSummary}.`
      );
    } else if (pageState.hasNamespace) {
      parts.push(
        `The page that ran the closure is still loaded (${String(pageState.pageAgeInMilliseconds)}ms old, older than the ${String(sinceEvalStartInMilliseconds)}ms since the eval started, harness namespace present), so the result was lost between the page and the driver rather than by a reload: ${pageSummary}.`
      );
    } else {
      parts.push(
        `The page is ${String(pageState.pageAgeInMilliseconds)}ms old, older than the eval, but carries no harness namespace, so it is not the page the closure ran in: ${pageSummary}.`
      );
    }
  }

  parts.push(
    logLines.length === 0
      ? 'The device log names no renderer or app process going away.'
      : `The device log says:\n${logLines.map((line) => `  ${line}`).join('\n')}`
  );

  return parts.join(' ');
}

/**
 * Parses the probe's answer.
 *
 * @param raw - What the probe expression returned.
 * @returns The page state, or `null` when the answer is not the probe's JSON.
 */
export function parseLostEvalPageState(raw: string): LostEvalPageState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const { hasNamespace, href, isLayoutReady, pageAgeInMilliseconds, readyState } = record;
  return typeof hasNamespace !== 'boolean'
      || typeof href !== 'string'
      || typeof isLayoutReady !== 'boolean'
      || typeof pageAgeInMilliseconds !== 'number'
      || typeof readyState !== 'string'
    ? null
    : { hasNamespace, href, isLayoutReady, pageAgeInMilliseconds, readyState };
}

/**
 * Picks the device log lines that name a renderer or app process going away.
 *
 * @param logText - The device log, oldest first.
 * @returns At most {@link MAX_LOG_LINES} matching lines, newest last.
 */
export function selectPageReplacementLogLines(logText: string): string[] {
  return logText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => PAGE_REPLACEMENT_LOG_LINE_PATTERN.test(line))
    .slice(-MAX_LOG_LINES);
}
