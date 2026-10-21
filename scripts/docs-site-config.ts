/**
 * @file
 *
 * This repository's documentation site, shared by `astro.config.ts` and the `docs:*` scripts.
 */

import type { DocsSiteConfig } from '@mnaoumov/typescript-dev-toolkit/docs-site/docs-site-config';

/**
 * Types this package's public signatures mention that the toolkit's built-in TypeScript, MDN and Node maps do not
 * link: the driver types it re-exposes (WebdriverIO's `Browser` on the Appium transport, Puppeteer's `CDPSession` on
 * the desktop one) and the few Node and Web types its helpers name.
 */
// Cspell:disable -- URL fragments are not words
const EXTERNAL_TYPE_LINKS = new Map<string, string>([
  ['AbortSignal', 'https://developer.mozilla.org/docs/Web/API/AbortSignal'],
  ['Browser', 'https://webdriver.io/docs/api/browser/'],
  ['CDPSession', 'https://pptr.dev/api/puppeteer.cdpsession'],
  ['ChildProcess', 'https://nodejs.org/api/child_process.html#class-childprocess'],
  ['Dirent', 'https://nodejs.org/api/fs.html#class-fsdirent'],
  ['Element', 'https://developer.mozilla.org/docs/Web/API/Element'],
  ['ErrorOptions', 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Error/Error#options'],
  ['HTMLElement', 'https://developer.mozilla.org/docs/Web/API/HTMLElement'],
  ['URL', 'https://developer.mozilla.org/docs/Web/API/URL'],
  ['WebSocket', 'https://developer.mozilla.org/docs/Web/API/WebSocket']
]);
// Cspell:enable

export const DOCS_SITE_CONFIG: DocsSiteConfig = {
  externalTypeLinks: EXTERNAL_TYPE_LINKS,
  genericTypeParameters: ['Arg', 'Args', 'Callback', 'Input', 'Item', 'Key', 'Output', 'Params', 'Result', 'TContextId'],
  // The package re-exports its whole public API from the root entry. The `./vitest-*` / `./jest-*` subpaths are
  // runner configuration modules, not API surface.
  publicApiEntry: 'src/index.ts',
  repo: 'obsidian-integration-testing',
  title: 'Obsidian Integration Testing'
};
