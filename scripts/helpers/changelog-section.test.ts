/**
 * @file
 *
 * Tests for `extractChangelogSection` and `toChangelogSectionDocument`.
 *
 * The shapes pinned here are the ones the release actually composes: a section bounded by the previous
 * release, the FIRST release's section bounded by nothing at all, and the empty section a release with no
 * commits to describe produces. The middle one is the one worth having a test for -- a bound of "the next
 * `##` heading" reads as an edge case and is in fact the normal shape of `1.0.0`.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import {
  extractChangelogSection,
  toChangelogSectionDocument
} from './changelog-section.ts';

const CHANGELOG_WITH_PREVIOUS_RELEASE = [
  '# CHANGELOG',
  '',
  '## 14.2.0',
  '',
  '- feat: settle the changelog before it is written',
  '- fix: stop reading the tag off a heading',
  '',
  '## 14.1.0',
  '',
  '- chore: teach the dictionary a word',
  ''
].join('\n');

const FIRST_RELEASE_CHANGELOG = [
  '# CHANGELOG',
  '',
  '## 1.0.0',
  '',
  '- feat: the first release',
  ''
].join('\n');

describe('extractChangelogSection', () => {
  it('reads the new section, stopping at the previous release', () => {
    expect(extractChangelogSection(CHANGELOG_WITH_PREVIOUS_RELEASE, '14.2.0')).toBe(
      '- feat: settle the changelog before it is written\n- fix: stop reading the tag off a heading'
    );
  });

  it('reads an older section too', () => {
    expect(extractChangelogSection(CHANGELOG_WITH_PREVIOUS_RELEASE, '14.1.0')).toBe('- chore: teach the dictionary a word');
  });

  // A first release is bounded by the end of the file, not by a `##`. Requiring a following heading is what
  // made the sibling implementation publish empty release notes for every `1.0.0`.
  it('reads the only section of a first release', () => {
    expect(extractChangelogSection(FIRST_RELEASE_CHANGELOG, '1.0.0')).toBe('- feat: the first release');
  });

  // `##` with its trailing space, so a sub-heading inside the section does not truncate it.
  it('keeps a sub-heading inside the section', () => {
    const changelog = '# CHANGELOG\n\n## 2.0.0\n\n### Breaking\n\n- feat!: rename everything\n\n## 1.0.0\n\n- feat: the first release\n';
    expect(extractChangelogSection(changelog, '2.0.0')).toBe('### Breaking\n\n- feat!: rename everything');
  });

  it('reads an empty section as empty', () => {
    expect(extractChangelogSection('# CHANGELOG\n\n## 1.0.0\n\n', '1.0.0')).toBe('');
  });

  it('reads a version the changelog does not carry as empty', () => {
    expect(extractChangelogSection(CHANGELOG_WITH_PREVIOUS_RELEASE, '99.0.0')).toBe('');
  });

  it('reads a CRLF changelog', () => {
    expect(extractChangelogSection(FIRST_RELEASE_CHANGELOG.replaceAll('\n', '\r\n'), '1.0.0')).toBe('- feat: the first release');
  });
});

describe('toChangelogSectionDocument', () => {
  // Character-for-character the head of the file about to be written, which is what makes a reported line
  // number the written file's own.
  it('wraps the section in the head of the file it will become', () => {
    expect(toChangelogSectionDocument(CHANGELOG_WITH_PREVIOUS_RELEASE, '14.2.0')).toBe(
      '# CHANGELOG\n\n## 14.2.0\n\n- feat: settle the changelog before it is written\n- fix: stop reading the tag off a heading\n'
    );
    expect(CHANGELOG_WITH_PREVIOUS_RELEASE.startsWith(toChangelogSectionDocument(CHANGELOG_WITH_PREVIOUS_RELEASE, '14.2.0'))).toBe(true);
  });

  // A release with no commits to describe is a real shape, and appending a blank body to the heading would
  // report a defect this release did not commit.
  it('leaves an empty section as a bare heading', () => {
    expect(toChangelogSectionDocument('# CHANGELOG\n\n## 1.0.0\n\n', '1.0.0')).toBe('# CHANGELOG\n\n## 1.0.0\n');
  });
});
