/**
 * @file
 *
 * Cuts one version's section out of a composed `CHANGELOG.md` and wraps it in the minimal document the
 * release's checks are handed.
 *
 * Only the NEW section is checked, and deliberately so. The honest check is the whole file, but it fails a
 * release on a defect in a section somebody shipped years ago -- which is a release nobody can cut without
 * first fixing history, and is exactly how a changelog defect becomes a permanent blocker instead of a
 * two-minute fix. That is not hypothetical: it is the state five sibling repositories are in, each with a
 * coined word already published in an old section. The new section is the only part this release is
 * responsible for.
 *
 * Pure, and here rather than in `version.ts` for the same reason `breaking-change.ts` and `npm-pack.ts` are:
 * `version.ts` runs `await main()` at top level, so nothing can import it to test it.
 */

/**
 * Extracts the body of one version's `CHANGELOG.md` section -- everything between its `## <version>` heading
 * and whichever comes first, the next `## ` heading or the end of the file.
 *
 * Ending at the end of the file is not an edge case but the normal shape of a FIRST release: sections are
 * prepended, so the newest one is bounded by the previous release only once a previous release exists.
 * Terminating on `'## '` WITH its trailing space is what keeps an `###` sub-heading inside the section
 * instead of truncating it there.
 *
 * @param changelogContent - The full contents of `CHANGELOG.md`.
 * @param version - The version whose section to extract.
 * @returns The section body, trimmed, or an empty string when the changelog has no section for that version.
 */
export function extractChangelogSection(changelogContent: string, version: string): string {
  const lines = changelogContent.split(/\r?\n/);
  const headingIndex = lines.indexOf(`## ${version}`);
  if (headingIndex === NOT_FOUND_INDEX) {
    return '';
  }

  const bodyStartIndex = headingIndex + 1;
  const nextHeadingOffset = lines.slice(bodyStartIndex).findIndex((line) => line.startsWith('## '));
  const bodyEndIndex = nextHeadingOffset === NOT_FOUND_INDEX ? lines.length : bodyStartIndex + nextHeadingOffset;
  return lines.slice(bodyStartIndex, bodyEndIndex).join('\n').trim();
}

/**
 * Wraps one version's changelog section in the minimal document the checks are handed.
 *
 * The section goes inside a document rather than on its own, so the heading and list rules see the context
 * they need (a document whose first line is a list item is a different document). The line numbers a finding
 * reports are then the composed `CHANGELOG.md`'s own, which is not a coincidence and is worth keeping: a
 * section is PREPENDED, so this document is character-for-character the head of the file about to be written.
 *
 * @param changelogContent - The full composed `CHANGELOG.md` content.
 * @param version - The version whose section is about to be published.
 * @returns The minimal document to check.
 */
export function toChangelogSectionDocument(changelogContent: string, version: string): string {
  const heading = `# CHANGELOG\n\n## ${version}`;
  const section = extractChangelogSection(changelogContent, version);
  // An empty section is a real shape -- a release with no commits to describe -- and appending a blank body
  // to the heading would report a defect this release did not commit.
  return section === '' ? `${heading}\n` : `${heading}\n\n${section}\n`;
}

/**
 * What `indexOf` and `findIndex` return when nothing matches.
 */
const NOT_FOUND_INDEX = -1;
