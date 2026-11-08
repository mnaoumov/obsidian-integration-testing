import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  buildEnableCommunityPluginsAndReloadExpression,
  checkShouldReloadForStartupPlugins,
  parseStartupPluginLoad,
  RELOAD_DELAY_IN_MILLISECONDS,
  STARTUP_PLUGIN_LOAD_PROBE_EXPRESSION
} from './startup-plugin-load.ts';

interface FakeApp {
  readonly appId?: string;
  readonly plugins?: FakePlugins;
}

interface FakePlugins {
  readonly enabledPlugins?: Set<string>;
  readonly isEnabled?: () => boolean;
  readonly manifests?: Record<string, unknown>;
  readonly plugins?: Record<string, unknown>;
}

function runProbe(app: FakeApp | undefined): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- The expression is evaluated in a renderer in production; here it runs against a stub window.
  const probe = new Function('window', `return ${STARTUP_PLUGIN_LOAD_PROBE_EXPRESSION};`) as (window: unknown) => unknown;
  return probe({ app });
}

describe('STARTUP_PLUGIN_LOAD_PROBE_EXPRESSION', () => {
  it('reports unsupported without a plugin registry', () => {
    expect(parseStartupPluginLoad(runProbe(undefined))).toEqual({ state: 'unsupported' });
    expect(parseStartupPluginLoad(runProbe({ appId: 'a', plugins: {} }))).toEqual({ state: 'unsupported' });
  });

  it('reports loaded when every enabled plugin with a manifest is loaded', () => {
    const result = runProbe({
      appId: 'a',
      plugins: {
        enabledPlugins: new Set(['gone', 'one']),
        isEnabled: (): boolean => true,
        manifests: { one: {} },
        plugins: { one: {} }
      }
    });
    expect(parseStartupPluginLoad(result)).toEqual({ loadedPluginIds: ['one'], state: 'loaded' });
  });

  it('reports the skipped plugins in restricted mode', () => {
    const result = runProbe({
      appId: 'vault-id',
      plugins: {
        enabledPlugins: new Set(['one', 'two']),
        isEnabled: (): boolean => false,
        manifests: { one: {}, two: {} },
        plugins: { two: {} }
      }
    });
    expect(parseStartupPluginLoad(result)).toEqual({
      appId: 'vault-id',
      isCommunityPluginsEnabled: false,
      skippedPluginIds: ['one'],
      state: 'skipped'
    });
  });

  it('reads isEnabled as false when the registry lacks it', () => {
    const result = runProbe({
      appId: 'vault-id',
      plugins: { enabledPlugins: new Set(['one']), manifests: { one: {} }, plugins: {} }
    });
    expect(parseStartupPluginLoad(result)).toMatchObject({ isCommunityPluginsEnabled: false, state: 'skipped' });
  });
});

describe('parseStartupPluginLoad', () => {
  it.each([
    undefined,
    42,
    'not json',
    'null',
    '"text"',
    JSON.stringify({ state: 'loaded' }),
    JSON.stringify({ loadedPluginIds: [1], state: 'loaded' }),
    JSON.stringify({ appId: 'a', skippedPluginIds: ['x'], state: 'skipped' }),
    JSON.stringify({ state: 'other' })
  ])('reads %j as unsupported', (value) => {
    expect(parseStartupPluginLoad(value)).toEqual({ state: 'unsupported' });
  });
});

describe('checkShouldReloadForStartupPlugins', () => {
  it('reloads only for a skip with a usable app id', () => {
    expect(checkShouldReloadForStartupPlugins({ appId: 'id', isCommunityPluginsEnabled: true, skippedPluginIds: ['x'], state: 'skipped' })).toBe(true);
    expect(checkShouldReloadForStartupPlugins({ appId: '', isCommunityPluginsEnabled: false, skippedPluginIds: ['x'], state: 'skipped' })).toBe(false);
    expect(checkShouldReloadForStartupPlugins({ appId: 'undefined', isCommunityPluginsEnabled: false, skippedPluginIds: ['x'], state: 'skipped' }))
      .toBe(false);
    expect(checkShouldReloadForStartupPlugins({ loadedPluginIds: [], state: 'loaded' })).toBe(false);
    expect(checkShouldReloadForStartupPlugins({ state: 'unsupported' })).toBe(false);
  });
});

describe('buildEnableCommunityPluginsAndReloadExpression', () => {
  it('writes the key and schedules a reload', () => {
    vi.useFakeTimers();
    try {
      const storage = new Map<string, string>();
      const reload = vi.fn();
      const fakeWindow = {
        location: { reload },
        setTimeout: (callback: () => void, delayInMilliseconds: number): unknown => setTimeout(callback, delayInMilliseconds)
      };
      const fakeLocalStorage = {
        setItem: (key: string, value: string): void => {
          storage.set(key, value);
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- See runProbe.
      const run = new Function('window', 'localStorage', `return ${buildEnableCommunityPluginsAndReloadExpression('vault-id')};`) as (
        window: unknown,
        localStorage: unknown
      ) => unknown;
      expect(run(fakeWindow, fakeLocalStorage)).toBe(true);
      expect(storage.get('enable-plugin-vault-id')).toBe('true');
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(RELOAD_DELAY_IN_MILLISECONDS);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
