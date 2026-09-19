/**
 * @file
 *
 * Tests for `lintMarkdownContent`.
 *
 * The REAL `markdownlint-cli2` runs here rather than a mock of it, because the only thing worth proving is
 * the thing a mock replaces: that content which is on no disk is linted with the configuration `lint:md`
 * would have used for the file it is about to become. No suite under `scripts/` mocks anything, and this one
 * has no reason to be the first.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import { lintMarkdownContent } from './markdownlint-content.ts';
import { getRootFolder } from './root.ts';

// The path the virtual document is attributed to. It has to be a real path inside this repository, because
// that is what decides which configuration applies and where the path-relative rules walk from.
const CHANGELOG_PATH = `${getRootFolder() ?? '.'}/CHANGELOG.md`;

// Long enough to fail `MD013/line-length` at any of its usual settings, and it passes here only because this
// repository turns that rule off.
const LONG_LINE_LENGTH = 200;

describe('lintMarkdownContent', () => {
  it('reports nothing for content that passes', async () => {
    const findings = await lintMarkdownContent({
      content: '# CHANGELOG\n\n## 1.0.0\n\n- feat: add a shiny new feature\n',
      filePath: CHANGELOG_PATH
    });

    expect(findings).toEqual([]);
  });

  it('reports a finding, naming the path the content was linted as', async () => {
    const findings = await lintMarkdownContent({
      content: '# CHANGELOG\n\n## 1.0.0\n\n- feat: a change\n   - with a badly indented sub-item\n',
      filePath: CHANGELOG_PATH
    });

    expect(findings).toHaveLength(1);
    // The line number is the written file's own: the section is prepended, so this document is the head of it.
    expect(findings[0]).toContain('CHANGELOG.md:6');
    expect(findings[0]).toContain('MD007/ul-indent');
  });

  it('reports a bare URL, the defect a commit subject carries into a release note', async () => {
    const findings = await lintMarkdownContent({
      content: '# CHANGELOG\n\n## 1.0.0\n\n- fix: see https://example.com for the details\n',
      filePath: CHANGELOG_PATH
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('CHANGELOG.md:5');
    expect(findings[0]).toContain('MD034/no-bare-urls');
  });

  // The whole point of going through `markdownlint-cli2` rather than `markdownlint`'s own string API: this
  // repository's `.markdownlint-cli2.mjs` turns `MD013/line-length` off, and stock defaults fail at 80
  // columns. A document that exists nowhere on disk passing this can only mean that configuration was found
  // and applied to it.
  it('applies this repository\'s own configuration', async () => {
    const findings = await lintMarkdownContent({
      content: `# CHANGELOG\n\n## 1.0.0\n\n- feat: ${'a'.repeat(LONG_LINE_LENGTH)}\n`,
      filePath: CHANGELOG_PATH
    });

    expect(findings).toEqual([]);
  });

  // The other half of that: the configuration names a custom rule, and loading it is something only the
  // `markdownlint-cli2` layer does. It resolves from the folder of the path the content is attributed to,
  // which is why that path has to be the real one.
  it('applies the custom rule the configuration names, resolving from the attributed path', async () => {
    const findings = await lintMarkdownContent({
      content: '# CHANGELOG\n\n## 1.0.0\n\n- docs: see [the notes](./no-such-file.md)\n',
      filePath: CHANGELOG_PATH
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('relative-links');

    const resolvableFindings = await lintMarkdownContent({
      content: '# CHANGELOG\n\n## 1.0.0\n\n- docs: see [the readme](./README.md)\n',
      filePath: CHANGELOG_PATH
    });

    expect(resolvableFindings).toEqual([]);
  });

  // `noGlobs`. Without it the configuration's own `**/*.md` would be expanded too, and one document's check
  // would lint the whole repository -- reporting findings this release has no business failing on, and taking
  // seconds to do it.
  it('lints only the given document, never the repository\'s own files', async () => {
    const findings = await lintMarkdownContent({
      content: '# CHANGELOG\n\n## 1.0.0\n\n- feat: a change\n   - with a badly indented sub-item\n',
      filePath: CHANGELOG_PATH
    });

    expect(findings.every((finding) => finding.startsWith('CHANGELOG.md:'))).toBe(true);
  });
});
