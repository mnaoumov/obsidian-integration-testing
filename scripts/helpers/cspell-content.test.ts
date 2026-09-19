/**
 * @file
 *
 * Tests for `spellcheckContent`.
 *
 * The REAL `cspell` runs here rather than a mock of it, because the only thing worth proving is the thing a
 * mock replaces: that content which is on no disk is checked with the configuration `spellcheck` would have
 * used for the file it is about to become. No suite under `scripts/` mocks anything, and this one has no
 * reason to be the first.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import { spellcheckContent } from './cspell-content.ts';
import { getRootFolder } from './root.ts';

// `spellcheck` reads this file too, so the unknown word cannot be written here as a literal -- doing so would
// put the very defect this module exists to catch into the repository, and turn the gate red on the next
// release. Both halves are ordinary English words `cspell` knows; only their concatenation is unknown to it.
const UNKNOWN_WORD = ['lint', 'able'].join('');

// The path the virtual document is attributed to. It has to be a real path inside this repository, because
// that is what decides which `cspell.json` applies.
const CHANGELOG_PATH = `${getRootFolder() ?? '.'}/CHANGELOG.md`;

describe('spellcheckContent', () => {
  it('reports nothing for content that passes', async () => {
    const findings = await spellcheckContent({
      content: '# CHANGELOG\n\n## 1.0.0\n\n- feat: add a shiny new feature\n',
      filePath: CHANGELOG_PATH
    });

    expect(findings).toEqual([]);
  });

  it('reports a finding, naming the path the content was checked as', async () => {
    const findings = await spellcheckContent({
      content: `# CHANGELOG\n\n## 1.0.0\n\n- feat: a ${UNKNOWN_WORD} change\n`,
      filePath: CHANGELOG_PATH
    });

    expect(findings).toHaveLength(1);
    // The line number is the written file's own: the section is prepended, so this document is the head of it.
    expect(findings[0]).toContain('CHANGELOG.md:5');
    expect(findings[0]).toContain(UNKNOWN_WORD);
  });

  // The whole point of the `stdin://<path>` form rather than a temp file outside the repository:
  // `adgnetworksockdrv` is in no dictionary anywhere, only in this repository's own `cspell.json`, so
  // accepting it can only mean that configuration was found and applied to a document that exists nowhere on
  // disk.
  it('applies this repository\'s own word list', async () => {
    const findings = await spellcheckContent({
      content: '# CHANGELOG\n\n## 1.0.0\n\n- fix: stop excluding adgnetworksockdrv\n',
      filePath: CHANGELOG_PATH
    });

    expect(findings).toEqual([]);
  });

  it('reports one finding per reported line', async () => {
    const findings = await spellcheckContent({
      content: `# CHANGELOG\n\n## 1.0.0\n\n- feat: a ${UNKNOWN_WORD} change\n- fix: another ${UNKNOWN_WORD} one\n`,
      filePath: CHANGELOG_PATH
    });

    expect(findings).toHaveLength(2);
    expect(findings[1]).toContain('CHANGELOG.md:6');
  });
});
