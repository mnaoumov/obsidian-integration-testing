import {
  describe,
  expect,
  it
} from 'vitest';

import { DesktopOnlyPluginSkipError } from './desktop-only-plugin-skip-error.ts';

describe('DesktopOnlyPluginSkipError', () => {
  const error = new DesktopOnlyPluginSkipError('fix-tab-size');

  it('is an Error with the specific name', () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DesktopOnlyPluginSkipError');
  });

  it('names the plugin and the manifest field in the message', () => {
    expect(error.message).toContain('fix-tab-size');
    expect(error.message).toContain('isDesktopOnly');
  });

  it('exposes the plugin id as a field', () => {
    expect(error.pluginId).toBe('fix-tab-size');
  });

  it('carries no stack frames', () => {
    // An expected skip, not a defect. The trace is the whole reason a green release run reads as broken,
    // So the stack is the message and nothing else -- no `at ...` frames pointing into the harness.
    expect(error.stack).toBe(`${error.name}: ${error.message}`);
    expect(error.stack).not.toContain('    at ');
  });
});
