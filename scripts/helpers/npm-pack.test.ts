/**
 * @file
 *
 * Tests for `parseNpmPackFilename`.
 *
 * The npm 12 payload below is captured verbatim from `npm pack --json` in this repo on npm 12.0.2 /
 * Node 26.5.0, 2026-09-01 -- the exact output that broke the 12.0.0 release. Keeping BOTH
 * generations pinned here is the point of the suite: the defect it guards is invisible to the type
 * system (both shapes are valid JSON) and only surfaces after a release has already tagged and pushed.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import { parseNpmPackFilename } from './npm-pack.ts';

const NPM_11_OUTPUT = JSON.stringify([
  {
    filename: 'obsidian-integration-testing-12.0.0.tgz',
    files: [],
    id: 'obsidian-integration-testing@12.0.0',
    name: 'obsidian-integration-testing',
    version: '12.0.0'
  }
]);

const NPM_12_OUTPUT = JSON.stringify({
  'obsidian-integration-testing': {
    filename: 'obsidian-integration-testing-12.0.0.tgz',
    files: [],
    id: 'obsidian-integration-testing@12.0.0',
    name: 'obsidian-integration-testing',
    version: '12.0.0'
  }
});

describe('parseNpmPackFilename', () => {
  it('reads the npm <= 11 array shape', () => {
    expect(parseNpmPackFilename(NPM_11_OUTPUT)).toBe('obsidian-integration-testing-12.0.0.tgz');
  });

  it('reads the npm 12 package-name-keyed object shape', () => {
    expect(parseNpmPackFilename(NPM_12_OUTPUT)).toBe('obsidian-integration-testing-12.0.0.tgz');
  });

  it('throws naming the raw output when it is not JSON', () => {
    const rawOutput = 'npm ERR! code ENOENT';
    expect(() => parseNpmPackFilename(rawOutput)).toThrow(rawOutput);
  });

  it.each([
    ['a string', '"obsidian-integration-testing-12.0.0.tgz"'],
    ['a number', '42'],
    ['null', 'null']
  ])('throws when the JSON is %s rather than an array or object', (_description, rawOutput) => {
    expect(() => parseNpmPackFilename(rawOutput)).toThrow(
      'Expected \'npm pack --json\' output to be an array or an object'
    );
  });

  it.each([
    ['an empty array', '[]'],
    ['an empty object', '{}'],
    ['an entry without a filename', '[{ "id": "pkg@1.0.0" }]'],
    ['an entry whose filename is not a string', '[{ "filename": 42 }]'],
    ['an entry whose filename is empty', '[{ "filename": "" }]'],
    ['an npm 12 entry without a filename', '{ "pkg": { "id": "pkg@1.0.0" } }']
  ])('throws naming the raw output given %s', (_description, rawOutput) => {
    expect(() => parseNpmPackFilename(rawOutput)).toThrow(rawOutput);
  });
});
