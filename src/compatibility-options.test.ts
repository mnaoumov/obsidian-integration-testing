import {
  describe,
  expect,
  it
} from 'vitest';

import {
  resolveAsarFallbackAction,
  resolveInstallerCompatibilityAction,
  resolveShouldThrowOnIncompatibleInstaller,
  resolveShouldThrowOnSilentAsarFallback,
  resolveShouldWarnOnCompatibilityIssues
} from './compatibility-options.ts';

describe('resolveShouldWarnOnCompatibilityIssues', () => {
  it('should warn by default when the option is omitted', () => {
    expect(resolveShouldWarnOnCompatibilityIssues()).toBe(true);
    expect(resolveShouldWarnOnCompatibilityIssues(undefined)).toBe(true);
  });

  it('should not warn when explicitly disabled', () => {
    expect(resolveShouldWarnOnCompatibilityIssues(false)).toBe(false);
  });

  it('should warn when explicitly enabled', () => {
    expect(resolveShouldWarnOnCompatibilityIssues(true)).toBe(true);
  });
});

describe('resolveShouldThrowOnIncompatibleInstaller', () => {
  it('should throw by default when the option is omitted', () => {
    expect(resolveShouldThrowOnIncompatibleInstaller()).toBe(true);
    expect(resolveShouldThrowOnIncompatibleInstaller(undefined)).toBe(true);
  });

  it('should not throw when explicitly disabled', () => {
    expect(resolveShouldThrowOnIncompatibleInstaller(false)).toBe(false);
  });

  it('should throw when explicitly enabled', () => {
    expect(resolveShouldThrowOnIncompatibleInstaller(true)).toBe(true);
  });
});

describe('resolveShouldThrowOnSilentAsarFallback', () => {
  it('should throw by default when the option is omitted', () => {
    expect(resolveShouldThrowOnSilentAsarFallback()).toBe(true);
    expect(resolveShouldThrowOnSilentAsarFallback(undefined)).toBe(true);
  });

  it('should not throw when explicitly disabled', () => {
    expect(resolveShouldThrowOnSilentAsarFallback(false)).toBe(false);
  });

  it('should throw when explicitly enabled', () => {
    expect(resolveShouldThrowOnSilentAsarFallback(true)).toBe(true);
  });
});

describe('resolveAsarFallbackAction', () => {
  it('should throw for a fallback verdict when the throw is enabled', () => {
    expect(resolveAsarFallbackAction({
      shouldThrowOnSilentAsarFallback: true,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'fallback'
    })).toBe('throw');
    // The throw wins even when warnings are off.
    expect(resolveAsarFallbackAction({
      shouldThrowOnSilentAsarFallback: true,
      shouldWarnOnCompatibilityIssues: false,
      tier: 'fallback'
    })).toBe('throw');
  });

  it('should warn and proceed for a fallback verdict when the throw is disabled and warnings are on', () => {
    expect(resolveAsarFallbackAction({
      shouldThrowOnSilentAsarFallback: false,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'fallback'
    })).toBe('warn');
  });

  it('should stay silent for a fallback verdict when the throw is disabled and warnings are off', () => {
    expect(resolveAsarFallbackAction({
      shouldThrowOnSilentAsarFallback: false,
      shouldWarnOnCompatibilityIssues: false,
      tier: 'fallback'
    })).toBe('silent');
  });

  it('should stay silent for match and unknown verdicts regardless of the knobs', () => {
    expect(resolveAsarFallbackAction({
      shouldThrowOnSilentAsarFallback: true,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'match'
    })).toBe('silent');
    expect(resolveAsarFallbackAction({
      shouldThrowOnSilentAsarFallback: true,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'unknown'
    })).toBe('silent');
  });
});

describe('resolveInstallerCompatibilityAction', () => {
  it('should throw for an unrunnable verdict when the proactive throw is enabled', () => {
    expect(resolveInstallerCompatibilityAction({
      shouldThrowOnIncompatibleInstaller: true,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'unrunnable'
    })).toBe('throw');
    // The throw wins even when warnings are off.
    expect(resolveInstallerCompatibilityAction({
      shouldThrowOnIncompatibleInstaller: true,
      shouldWarnOnCompatibilityIssues: false,
      tier: 'unrunnable'
    })).toBe('throw');
  });

  it('should warn and proceed for an unrunnable verdict when the throw is disabled and warnings are on', () => {
    expect(resolveInstallerCompatibilityAction({
      shouldThrowOnIncompatibleInstaller: false,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'unrunnable'
    })).toBe('warn-unrunnable');
  });

  it('should stay silent for an unrunnable verdict when the throw is disabled and warnings are off', () => {
    expect(resolveInstallerCompatibilityAction({
      shouldThrowOnIncompatibleInstaller: false,
      shouldWarnOnCompatibilityIssues: false,
      tier: 'unrunnable'
    })).toBe('silent');
  });

  it('should warn for a nagged verdict when warnings are on', () => {
    expect(resolveInstallerCompatibilityAction({
      shouldThrowOnIncompatibleInstaller: true,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'nagged'
    })).toBe('warn-nagged');
  });

  it('should stay silent for a nagged verdict when warnings are off', () => {
    expect(resolveInstallerCompatibilityAction({
      shouldThrowOnIncompatibleInstaller: true,
      shouldWarnOnCompatibilityIssues: false,
      tier: 'nagged'
    })).toBe('silent');
  });

  it('should stay silent for ok and unknown verdicts regardless of the knobs', () => {
    expect(resolveInstallerCompatibilityAction({
      shouldThrowOnIncompatibleInstaller: true,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'ok'
    })).toBe('silent');
    expect(resolveInstallerCompatibilityAction({
      shouldThrowOnIncompatibleInstaller: true,
      shouldWarnOnCompatibilityIssues: true,
      tier: 'unknown'
    })).toBe('silent');
  });
});
