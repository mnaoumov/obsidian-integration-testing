/**
 * @file
 *
 * What the Android transport waits for after it re-attaches ChromeDriver to a WebView window that had closed.
 *
 * A closed window is often a page that is being replaced: Obsidian Mobile reloading, or its activity being
 * brought back to the front. The window ChromeDriver is moved to can therefore be a page with no `app` yet,
 * and an eval run there fails inside the harness's own wrapper with `Cannot read properties of undefined
 * (reading 'plugins')`, which reads as a test failure (AGENTS.md L81). So the eval waits until the page has
 * Obsidian's `app`, its plugin registry and a laid-out workspace, the state every `evalInObsidian` closure
 * assumes.
 */

/**
 * What {@link probeAppReadyAfterWindowRecovery} reports from the page.
 */
export interface AppReadyAfterWindowRecoveryProbe {
  /**
  Whether `globalThis.app` is defined.
   */
  readonly hasApp: boolean;

  /**
  Whether `app.plugins` is defined.
   */
  readonly hasPlugins: boolean;

  /**
  Whether `app.workspace.layoutReady` is truthy.
   */
  readonly isLayoutReady: boolean;
}

/**
 * Reports whether a probe shows a page an eval can run against.
 *
 * Anything that is not a probe object (the WebView answered something else) is not ready.
 *
 * @param probe - What the probe returned.
 * @returns `true` when the page has `app`, its plugin registry and a laid-out workspace.
 */
export function checkIsAppReadyAfterWindowRecovery(probe: unknown): boolean {
  if (typeof probe !== 'object' || probe === null) {
    return false;
  }

  const { hasApp, hasPlugins, isLayoutReady } = probe as Partial<AppReadyAfterWindowRecoveryProbe>;
  return hasApp === true && hasPlugins === true && isLayoutReady === true;
}

/**
 * Describes a probe for the log and the timeout message.
 *
 * @param probe - What the probe returned, or `undefined` when it could not run.
 * @returns A short description of how far the page has got.
 */
export function describeAppReadyAfterWindowRecoveryProbe(probe: unknown): string {
  if (typeof probe !== 'object' || probe === null) {
    return 'the WebView did not answer the probe';
  }

  const { hasApp, hasPlugins, isLayoutReady } = probe as Partial<AppReadyAfterWindowRecoveryProbe>;
  if (hasApp !== true) {
    return '`globalThis.app` does not exist yet';
  }
  if (hasPlugins !== true) {
    return '`app.plugins` does not exist yet';
  }
  return isLayoutReady === true ? 'ready' : '`app.workspace.layoutReady` is not true yet';
}

/* v8 ignore start -- Serialized and executed inside the WebView, not in Node. Covered by the Android integration tests. */

/**
 * Reads, inside the WebView, how far the page has got through Obsidian's startup.
 *
 * Must not reference any outer scope: it is serialized for `browser.execute`.
 *
 * @returns The probe result.
 */
export function probeAppReadyAfterWindowRecovery(): AppReadyAfterWindowRecoveryProbe {
  interface WorkspaceLike {
    readonly layoutReady?: unknown;
  }

  interface AppLike {
    readonly plugins?: unknown;
    readonly workspace?: WorkspaceLike;
  }

  interface AppHolder {
    readonly app?: AppLike;
  }

  const app = (globalThis as AppHolder).app;
  return {
    hasApp: app !== undefined,
    hasPlugins: app?.plugins !== undefined,
    isLayoutReady: app?.workspace?.layoutReady === true
  };
}

/* v8 ignore stop */
