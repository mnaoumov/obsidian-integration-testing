import {
  describe,
  expect,
  it
} from 'vitest';

import { generateLargeVault } from './large-vault-generator.ts';

function noteText(files: Record<string, unknown>, path: string): string {
  const text = files[path];
  if (typeof text !== 'string') {
    throw new TypeError(`No note at ${path}`);
  }
  return text;
}

describe('generateLargeVault', () => {
  it('generates the asked number of notes, spread over folders', () => {
    const files = generateLargeVault({ noteCount: 100 });
    const paths = Object.keys(files);

    expect(paths).toHaveLength(100);
    expect(new Set(paths.map((path) => path.split('/', 2)[1])).size).toBe(10);
    expect(paths).toContain('generated/folder-0/note-00.md');
    expect(paths).toContain('generated/folder-9/note-99.md');
  });

  it('gives the same map for the same seed, and a different one for another seed', () => {
    expect(generateLargeVault({ noteCount: 50, seed: 7 })).toStrictEqual(generateLargeVault({ noteCount: 50, seed: 7 }));
    expect(generateLargeVault({ noteCount: 50, seed: 7 })).not.toStrictEqual(generateLargeVault({ noteCount: 50, seed: 8 }));
  });

  it('writes frontmatter, a heading, body text, links and an inline tag', () => {
    const text = noteText(generateLargeVault({ noteCount: 20, rootFolder: 'big' }), 'big/folder-0/note-00.md');

    expect(text).toMatch(/^---\naliases: \[\w+ 0\]\ncreated: 2024-01-01\ntags: \[topic-\d+, topic-\d+\]\n---\n\n# note-00\n\n[A-Z]/u);
    expect(text).toContain('## Links\n\n- [[');
    expect(text).toMatch(/\n#topic-\d+\n$/u);
    expect(text.match(/^- \[\[/gmu)).toHaveLength(3);
  });

  it('links only to other notes, by a name that exists, when no link is unresolved', () => {
    const files = generateLargeVault({ noteCount: 30, unresolvedLinkRatio: 0 });
    const names = new Set(Object.keys(files).map((path) => path.split('/').at(-1)?.replace('.md', '')));

    for (const [path, text] of Object.entries(files)) {
      const own = path.split('/').at(-1)?.replace('.md', '');
      const targets = [...String(text).matchAll(/\[\[(?<target>[^\]]+)\]\]/gu)].map((match) => match.groups?.['target']);
      expect(targets).toHaveLength(3);
      for (const target of targets) {
        expect(names.has(target)).toBe(true);
        expect(target).not.toBe(own);
      }
    }
  });

  it('makes every link unresolved at a ratio of 1', () => {
    const files = generateLargeVault({ noteCount: 10, unresolvedLinkRatio: 1 });
    for (const text of Object.values(files)) {
      expect(String(text)).toMatch(/\[\[missing-\d+\]\]/u);
      expect(String(text)).not.toContain('[[note-');
    }
  });

  it('caps links and tags at what exists, and leaves out the inline tag when there are no tags', () => {
    const text = noteText(
      generateLargeVault({ linksPerNote: 10, noteCount: 1, paragraphsPerNote: 0, tagCount: 0, tagsPerNote: 5 }),
      'generated/folder-0/note-0.md'
    );

    expect(text).toMatch(/^---\naliases: \[\w+ 0\]\ncreated: 2024-01-01\ntags: \[\]\n---\n\n# note-0\n\n## Links\n\n$/u);
  });

  it('honours an explicit folder count', () => {
    const files = generateLargeVault({ folderCount: 3, noteCount: 12 });
    expect(new Set(Object.keys(files).map((path) => path.split('/', 2)[1]))).toStrictEqual(new Set(['folder-0', 'folder-1', 'folder-2']));
  });

  it('refuses counts and ratios that make no vault', () => {
    expect(() => generateLargeVault({ noteCount: 0 })).toThrow('noteCount must be an integer of at least 1, got 0');
    expect(() => generateLargeVault({ noteCount: 1.5 })).toThrow('noteCount must be an integer');
    expect(() => generateLargeVault({ folderCount: 0, noteCount: 5 })).toThrow('folderCount');
    expect(() => generateLargeVault({ linksPerNote: -1, noteCount: 5 })).toThrow('linksPerNote');
    expect(() => generateLargeVault({ noteCount: 5, unresolvedLinkRatio: 1.5 })).toThrow('unresolvedLinkRatio must be between 0 and 1, got 1.5');
    expect(() => generateLargeVault({ noteCount: 5, unresolvedLinkRatio: NaN })).toThrow('unresolvedLinkRatio');
  });
});
