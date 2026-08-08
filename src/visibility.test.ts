import {
  describe,
  expect,
  it
} from 'vitest';

import {
  NO_SANDBOX_LAUNCH_FLAG,
  OWNED_HIDDEN_LAUNCH_FLAGS,
  resolveOwnedHiddenLaunchArguments,
  resolveSandboxLaunchArguments,
  shouldHideAppiumConsole,
  shouldHideEmulatorWindow,
  shouldHideObsidianApp
} from './visibility.ts';

describe('shouldHideObsidianApp', () => {
  it('should be visible by default when the option is omitted', () => {
    expect(shouldHideObsidianApp()).toBe(false);
    expect(shouldHideObsidianApp(undefined)).toBe(false);
  });

  it('should hide when explicitly not visible', () => {
    expect(shouldHideObsidianApp(false)).toBe(true);
  });

  it('should not hide when visible', () => {
    expect(shouldHideObsidianApp(true)).toBe(false);
  });
});

describe('shouldHideEmulatorWindow', () => {
  it('should hide by default when the option is omitted', () => {
    expect(shouldHideEmulatorWindow()).toBe(true);
    expect(shouldHideEmulatorWindow(undefined)).toBe(true);
  });

  it('should hide when explicitly not visible', () => {
    expect(shouldHideEmulatorWindow(false)).toBe(true);
  });

  it('should not hide when visible', () => {
    expect(shouldHideEmulatorWindow(true)).toBe(false);
  });
});

describe('shouldHideAppiumConsole', () => {
  it('should hide by default when the option is omitted', () => {
    expect(shouldHideAppiumConsole()).toBe(true);
    expect(shouldHideAppiumConsole(undefined)).toBe(true);
  });

  it('should hide when explicitly not visible', () => {
    expect(shouldHideAppiumConsole(false)).toBe(true);
  });

  it('should not hide when visible', () => {
    expect(shouldHideAppiumConsole(true)).toBe(false);
  });
});

describe('resolveOwnedHiddenLaunchArguments', () => {
  it('should return no extra input by default when the option is omitted', () => {
    expect(resolveOwnedHiddenLaunchArguments()).toStrictEqual([]);
    expect(resolveOwnedHiddenLaunchArguments(undefined)).toStrictEqual([]);
  });

  it('should return the keep-alive flags when explicitly not visible', () => {
    expect(resolveOwnedHiddenLaunchArguments(false)).toStrictEqual(OWNED_HIDDEN_LAUNCH_FLAGS);
  });

  it('should return a fresh array (not the shared constant) so callers cannot mutate it', () => {
    const input = resolveOwnedHiddenLaunchArguments(false);
    expect(input).not.toBe(OWNED_HIDDEN_LAUNCH_FLAGS);
  });

  it('should return no extra input when visible', () => {
    expect(resolveOwnedHiddenLaunchArguments(true)).toStrictEqual([]);
  });

  it('should include the occlusion-disable and backgrounding flags', () => {
    expect(OWNED_HIDDEN_LAUNCH_FLAGS).toContain('--disable-features=CalculateNativeWinOcclusion');
    expect(OWNED_HIDDEN_LAUNCH_FLAGS).toContain('--disable-background-timer-throttling');
    expect(OWNED_HIDDEN_LAUNCH_FLAGS).toContain('--disable-backgrounding-occluded-windows');
    expect(OWNED_HIDDEN_LAUNCH_FLAGS).toContain('--disable-renderer-backgrounding');
  });
});

describe('resolveSandboxLaunchArguments', () => {
  it('should return no extra input by default when the option is omitted', () => {
    expect(resolveSandboxLaunchArguments()).toStrictEqual([]);
    expect(resolveSandboxLaunchArguments(undefined)).toStrictEqual([]);
  });

  it('should return no extra input when the sandbox is kept', () => {
    expect(resolveSandboxLaunchArguments(false)).toStrictEqual([]);
  });

  it('should return the no-sandbox flag when the sandbox is disabled', () => {
    expect(resolveSandboxLaunchArguments(true)).toStrictEqual([NO_SANDBOX_LAUNCH_FLAG]);
  });

  it('should use the standard no-sandbox switch', () => {
    expect(NO_SANDBOX_LAUNCH_FLAG).toBe('--no-sandbox');
  });
});
