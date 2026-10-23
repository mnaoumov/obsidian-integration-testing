/**
 * @file
 *
 * Tests for `resolveFeedEntryVersion` and `checkIsFullFeedVersion`. The
 * slug/title pairs are real `obsidian.md/changelog.xml` entries, read on
 * 2026-10-23.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import {
  checkIsFullFeedVersion,
  resolveFeedEntryVersion
} from './changelog-feed.ts';

describe('resolveFeedEntryVersion', () => {
  it.each([
    { expected: '1.3.0', slugVersion: '1.3', titleVersion: '1.3.0' },
    { expected: '1.1.15', slugVersion: '1.1', titleVersion: '1.1.15' },
    { expected: '1.5.3', slugVersion: '1.5.3-diff', titleVersion: '1.5.3' }
  ])('should key the short slug $slugVersion by its title $titleVersion', ({ expected, slugVersion, titleVersion }) => {
    expect(resolveFeedEntryVersion({ slugVersion, titleVersion })).toBe(expected);
  });

  it.each([
    { slugVersion: '0.1.4', titleVersion: '1.0.4' },
    { slugVersion: '0.6.1', titleVersion: '0.6.0' }
  ])('should keep the full slug $slugVersion over the typo\'d title $titleVersion', ({ slugVersion, titleVersion }) => {
    expect(resolveFeedEntryVersion({ slugVersion, titleVersion })).toBe(slugVersion);
  });

  it('should keep a short slug whose title is short too', () => {
    expect(resolveFeedEntryVersion({ slugVersion: '1.2', titleVersion: '1.2' })).toBe('1.2');
  });

  it('should keep a short slug when the title names no version', () => {
    expect(resolveFeedEntryVersion({ slugVersion: '1.2', titleVersion: undefined })).toBe('1.2');
  });

  it('should keep a short slug whose title does not extend it', () => {
    expect(resolveFeedEntryVersion({ slugVersion: '1.3', titleVersion: '1.4.0' })).toBe('1.3');
  });
});

describe('checkIsFullFeedVersion', () => {
  it.each([
    { expected: true, version: '1.15.0' },
    { expected: false, version: '1.2' },
    { expected: false, version: '1.5.3-diff' }
  ])('should answer $expected for $version', ({ expected, version }) => {
    expect(checkIsFullFeedVersion(version)).toBe(expected);
  });
});
