import {
  describe,
  expect,
  it
} from 'vitest';

import {
  checkAvdExists,
  listAvailableAvds
} from './avd-list.ts';

describe('listAvailableAvds', () => {
  it('should parse one AVD name per line', () => {
    expect(listAvailableAvds('obsidian_test\nPixel_6_API_34\n')).toEqual(['obsidian_test', 'Pixel_6_API_34']);
  });

  it('should ignore blank lines and surrounding whitespace', () => {
    expect(listAvailableAvds('\n  obsidian_test  \n\n')).toEqual(['obsidian_test']);
  });

  it('should drop informational banner lines containing a pipe', () => {
    expect(
      listAvailableAvds('INFO    | Storing metrics in: /tmp/foo\nobsidian_test\n')
    ).toEqual(['obsidian_test']);
  });

  it('should return an empty array for empty output', () => {
    expect(listAvailableAvds('')).toEqual([]);
  });
});

describe('checkAvdExists', () => {
  it('should return true when the AVD is listed', () => {
    expect(checkAvdExists({ avdListOutput: 'obsidian_test\nPixel_6_API_34', avdName: 'obsidian_test' })).toBe(true);
  });

  it('should return false when the AVD is absent', () => {
    expect(checkAvdExists({ avdListOutput: 'Pixel_6_API_34', avdName: 'obsidian_test' })).toBe(false);
  });

  it('should return false for empty output', () => {
    expect(checkAvdExists({ avdListOutput: '', avdName: 'obsidian_test' })).toBe(false);
  });

  it('should not match a substring of a longer AVD name', () => {
    expect(checkAvdExists({ avdListOutput: 'obsidian_test_2', avdName: 'obsidian_test' })).toBe(false);
  });
});
