/**
 * @file
 *
 * Tests for the release gate that refuses a non-major bump over an unreleased breaking change.
 *
 * The multi-commit payload below is the real `git log 13.0.0..HEAD --format=%B -z` output of this repo on
 * 2026-09-15 -- the `refactor(types)!` commits that were sitting unreleased on `main`, one of them carrying
 * the `BREAKING CHANGE:` footer verbatim. Pinning real output is the point, the way `npm-pack.test.ts` pins
 * real npm output: the defect this guards is invisible to the type system and only surfaces at a release,
 * which is the one run nobody wants to debug.
 *
 * The version matrix is the other half. Every row states a bump that could really be typed against a real
 * `package.json` version, including the prerelease case -- the one that raises no major and must still be
 * allowed, because the raise already happened when the `premajor` was cut.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import {
  findBreakingCommitSubjects,
  isBreakingCommitMessage,
  isMajorRaise
} from './breaking-change.ts';

const BREAKING_FOOTER_COMMIT = `refactor(types)!: take method-signature-style to its \`property\` default

\`@typescript-eslint/method-signature-style\` was adopted here as \`['error', 'method']\`,
which converted 29 members to the shorthand method form.

BREAKING CHANGE: the public interfaces -- \`ObsidianTransport\` above all -- now declare
their function members as properties rather than methods. A class or object literal
implementing one has its parameters checked contravariantly instead of bivariantly, so an
implementation that narrowed a parameter type no longer compiles. Widen it to the
declared type.
`;

const PLAIN_COMMIT = `chore(deps): drop the dead markdown-it override

The advisory was backported, so the override pins nothing.
`;

const SUBJECT_ONLY_BREAKING_COMMIT = `refactor(types)!: land the deferred public params-options-name-match renames

The four renames the name-match rule could not satisfy, deferred to ride this major.
`;

/**
 * NUL-SEPARATED, and NUL-TERMINATED: `git log -z` replaces each message's terminating newline with a NUL,
 * so the payload ends with an empty record. Dropping it is not cosmetic -- an empty record has no subject.
 */
const REAL_GIT_LOG_OUTPUT = [
  SUBJECT_ONLY_BREAKING_COMMIT,
  BREAKING_FOOTER_COMMIT,
  PLAIN_COMMIT
].map((commitMessage) => `${commitMessage}\0`).join('');

/**
 * `[description, currentVersion, lastReleasedStableVersion, newVersion, expected]`.
 *
 * Typed explicitly because one column is nullable: left to inference, every parameter would widen to the
 * union of the whole table and `isMajorRaise` would not take them.
 */
const MAJOR_RAISE_CASES: [string, string, null | string, string, boolean][] = [
  ['a major bump', '13.0.0', '13.0.0', '14.0.0', true],
  ['a premajor bump', '13.0.0', '13.0.0', '14.0.0-beta.0', true],
  ['a manual version two majors up', '13.0.0', '13.0.0', '15.0.0', true],
  ['a minor bump', '13.0.0', '13.0.0', '13.1.0', false],
  ['a patch bump', '13.0.0', '13.0.0', '13.0.1', false],
  ['a manual version that keeps the major', '13.0.0', '13.0.0', '13.4.2', false],
  ['a prerelease bump off a stable version', '13.0.0', '13.0.0', '13.0.1-beta.0', false],
  ['a version below the current one', '13.0.0', '13.0.0', '12.0.0', false],
  ['a prerelease bump continuing an already-raised major', '14.0.0-beta.0', '13.0.0', '14.0.0-beta.1', true],
  ['the stable release that finishes a premajor', '14.0.0-beta.0', '13.0.0', '14.0.0', true],
  ['a minor bump inside an already-raised major', '14.0.0-beta.0', '13.0.0', '14.1.0', true],
  ['a prerelease whose major is already released stable', '14.0.0-beta.0', '14.0.0', '14.0.0-beta.1', false],
  ['a prerelease bump in a package with no stable release', '1.0.0-beta.0', null, '1.0.0-beta.1', true],
  ['a patch bump in a package with no release at all', '1.0.0', null, '1.0.1', false]
];

describe('findBreakingCommitSubjects', () => {
  it('reads the subjects of the breaking commits out of a real -z payload, in git log order', () => {
    expect(findBreakingCommitSubjects(REAL_GIT_LOG_OUTPUT)).toStrictEqual([
      'refactor(types)!: land the deferred public params-options-name-match renames',
      'refactor(types)!: take method-signature-style to its `property` default'
    ]);
  });

  it('returns nothing when no unreleased commit declares a breaking change', () => {
    expect(findBreakingCommitSubjects(`${PLAIN_COMMIT}\0`)).toStrictEqual([]);
  });

  it('returns nothing for an empty range, which is what a release with no commits since the tag looks like', () => {
    expect(findBreakingCommitSubjects('')).toStrictEqual([]);
  });

  it('survives a CRLF payload', () => {
    expect(findBreakingCommitSubjects(`${SUBJECT_ONLY_BREAKING_COMMIT.replaceAll('\n', '\r\n')}\0`)).toStrictEqual([
      'refactor(types)!: land the deferred public params-options-name-match renames'
    ]);
  });
});

describe('isBreakingCommitMessage', () => {
  it.each([
    ['a bare type', 'feat!: drop the legacy transport'],
    ['a scoped type', 'refactor(types)!: take method-signature-style to its `property` default'],
    ['an empty scope', 'chore()!: something'],
    ['a capitalized type', 'Feat!: drop the legacy transport']
  ])('reads the subject `!` of %s as breaking', (_description, commitMessage) => {
    expect(isBreakingCommitMessage(commitMessage)).toBe(true);
  });

  it.each([
    ['BREAKING CHANGE', 'feat: widen the transport\n\nBREAKING CHANGE: the bag is renamed.'],
    ['BREAKING-CHANGE', 'feat: widen the transport\n\nBREAKING-CHANGE: the bag is renamed.']
  ])('reads a %s footer as breaking', (_description, commitMessage) => {
    expect(isBreakingCommitMessage(commitMessage)).toBe(true);
  });

  it('reads the real footer commit as breaking', () => {
    expect(isBreakingCommitMessage(BREAKING_FOOTER_COMMIT)).toBe(true);
  });

  it.each([
    ['a plain conventional subject', 'feat: widen the transport'],
    ['a scoped conventional subject', 'fix(reg-exp): escape the dot'],
    ['an exclamation mark anywhere but before the colon', 'fix: do not panic!'],
    ['an exclamation mark in the body', 'fix: escape the dot\n\nIt was a mess!'],
    ['the phrase mid-line', 'fix: escape the dot\n\nThis is not a BREAKING CHANGE: it is a fix.'],
    ['an indented footer, which Conventional Commits does not define', 'fix: escape the dot\n\n  BREAKING CHANGE: nothing.'],
    ['a lowercase footer', 'fix: escape the dot\n\nbreaking change: nothing.'],
    ['an empty message', '']
  ])('does not read %s as breaking', (_description, commitMessage) => {
    expect(isBreakingCommitMessage(commitMessage)).toBe(false);
  });
});

describe('isMajorRaise', () => {
  it.each(MAJOR_RAISE_CASES)('%s', (_description, currentVersion, lastReleasedStableVersion, newVersion, expected) => {
    expect(isMajorRaise({ currentVersion, lastReleasedStableVersion, newVersion })).toBe(expected);
  });
});
