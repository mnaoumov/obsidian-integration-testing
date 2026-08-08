import {
  describe,
  expect,
  it
} from 'vitest';

import {
  resolveAsarFallbackAction,
  resolveInstallerCompatibilityAction,
  willThrowOnIncompatibleInstaller,
  willThrowOnSilentAsarFallback,
  willWarnOnCompatibilityIssues
} from './compatibility-options.ts';

describe('willWarnOnCompatibilityIssues', () => {
  it('should warn by default when the option is omitted', () => {
    expect(willWarnOnCompatibilityIssues()).toBe(true);
    expect(willWarnOnCompatibilityIssues(undefined)).toBe(true);
  });

  it('should not warn when explicitly disabled', () => {
    expect(willWarnOnCompatibilityIssues(false)).toBe(false);
  });

  it('should warn when explicitly enabled', () => {
    expect(willWarnOnCompatibilityIssues(true)).toBe(true);
  });
});

describe('willThrowOnIncompatibleInstaller', () => {
  it('should throw by default when the option is omitted', () => {
    expect(willThrowOnIncompatibleInstaller()).toBe(true);
    expect(willThrowOnIncompatibleInstaller(undefined)).toBe(true);
  });

  it('should not throw when explicitly disabled', () => {
    expect(willThrowOnIncompatibleInstaller(false)).toBe(false);
  });

  it('should throw when explicitly enabled', () => {
    expect(willThrowOnIncompatibleInstaller(true)).toBe(true);
  });
});

describe('willThrowOnSilentAsarFallback', () => {
  it('should throw by default when the option is omitted', () => {
    expect(willThrowOnSilentAsarFallback()).toBe(true);
    expect(willThrowOnSilentAsarFallback(undefined)).toBe(true);
  });

  it('should not throw when explicitly disabled', () => {
    expect(willThrowOnSilentAsarFallback(false)).toBe(false);
  });

  it('should throw when explicitly enabled', () => {
    expect(willThrowOnSilentAsarFallback(true)).toBe(true);
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
