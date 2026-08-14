/**
 * @file
 *
 * Constants and external-type link maps for the API documentation generator.
 */

import {
  join,
  resolve
} from 'node:path';

/**
The obsidian-integration-testing repo root. Override with DOCS_ROOT for out-of-tree runs.
*/
export const ROOT_DIR = process.env['DOCS_ROOT'] ?? resolve(process.cwd());

export const BASE_PATH = '/obsidian-integration-testing';

/**
The npm package every documented export is imported from. Unlike obsidian-dev-utils, which exposes one
import subpath per module, obsidian-integration-testing re-exports its whole public API from the root
entry — the runner-facing `./vitest-*` / `./jest-*` subpaths are configuration modules, not API surface.
*/
export const PACKAGE_NAME = 'obsidian-integration-testing';

/**
The barrel whose re-exports define the public API. Only names reachable from here are documented.
*/
export const PUBLIC_API_ENTRY_FILE = join(ROOT_DIR, 'src/index.ts');

export const OUTPUT_DIR = join(ROOT_DIR, 'docs/src/content/docs/api');

export const CACHE_FILE = join(OUTPUT_DIR, '.cache-hash');

export const SIDEBAR_FILE = join(ROOT_DIR, 'docs/src/generated-sidebar.json');

/**
Event-like method names that should be split by string literal first param
*/
export const EVENT_METHODS = new Set(['off', 'on', 'trigger', 'tryTrigger']);

/**
Single-letter and common generic type parameter names — not linkable
*/
export const GENERIC_TYPE_PARAMS = new Set([
  'Arg',
  'Args',
  'Callback',
  'Input',
  'Item',
  'K',
  'Key',
  'Output',
  'Params',
  'Result',
  'T',
  'TContextId',
  'U',
  'V'
]);

export const TS_HANDBOOK = 'https://www.typescriptlang.org/docs/handbook';

export const TS_PRIMITIVE_TYPES: Record<string, string> = {
  any: `${TS_HANDBOOK}/2/everyday-types.html#any`,
  boolean: `${TS_HANDBOOK}/basic-types.html#boolean`,
  never: `${TS_HANDBOOK}/basic-types.html#never`,
  null: `${TS_HANDBOOK}/basic-types.html#null-and-undefined`,
  number: `${TS_HANDBOOK}/basic-types.html#number`,
  object: `${TS_HANDBOOK}/basic-types.html#object`,
  string: `${TS_HANDBOOK}/basic-types.html#string`,
  symbol: `${TS_HANDBOOK}/symbols.html`,
  undefined: `${TS_HANDBOOK}/basic-types.html#null-and-undefined`,
  unknown: `${TS_HANDBOOK}/2/functions.html#unknown`,
  void: `${TS_HANDBOOK}/basic-types.html#void`
};

// Cspell:disable -- URL fragments are not words
export const TS_UTILITY_TYPES = new Map<string, string>([
  ['Awaited', 'awaitedtype'],
  ['Capitalize', 'capitalizestringtype'],
  ['ConstructorParameters', 'constructorparameterstype'],
  ['Exclude', 'excludeuniontype-excludedmembers'],
  ['Extract', 'extracttype-union'],
  ['InstanceType', 'instancetypetype'],
  ['Iterable', 'iterable-interface'],
  ['Lowercase', 'lowercasestringtype'],
  ['NoInfer', 'noinfertype'],
  ['NonNullable', 'nonnullabletype'],
  ['Omit', 'omittype-keys'],
  ['OmitThisParameter', 'omitthisparametertype'],
  ['Parameters', 'parameterstype'],
  ['Partial', 'partialtype'],
  ['Pick', 'picktype-keys'],
  ['Readonly', 'readonlytype'],
  ['Record', 'recordkeys-type'],
  ['Required', 'requiredtype'],
  ['ReturnType', 'returntypetype'],
  ['ThisParameterType', 'thisparametertypetype'],
  ['ThisType', 'thistypetype'],
  ['Uncapitalize', 'uncapitalizestringtype'],
  ['Uppercase', 'uppercasestringtype']
]);
// Cspell:enable

/**
 * Global / ambient type names that are not part of this package but appear in its public signatures.
 *
 * Scoped to what obsidian-integration-testing actually surfaces: JS + Node built-ins, the handful of
 * Web APIs its renderer-side helpers mention, and the driver types it re-exposes (WebdriverIO's
 * `Browser` on the Appium transport, Puppeteer's CDP types on the desktop transport).
 */
export const TS_GLOBAL_TYPES: Record<string, string> = {
  AbortSignal: 'https://developer.mozilla.org/docs/Web/API/AbortSignal',
  Array: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array',
  ArrayBufferLike: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer',
  ArrayLike: 'https://www.typescriptlang.org/docs/handbook/2/indexed-access-types.html',
  Browser: 'https://webdriver.io/docs/api/browser/',
  Buffer: 'https://nodejs.org/api/buffer.html#class-buffer',
  CDPSession: 'https://pptr.dev/api/puppeteer.cdpsession',
  ChildProcess: 'https://nodejs.org/api/child_process.html#class-childprocess',
  Dirent: 'https://nodejs.org/api/fs.html#class-fsdirent',
  Element: 'https://developer.mozilla.org/docs/Web/API/Element',
  Error: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Error',
  ErrorOptions: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Error/Error#options',
  Function: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Function',
  HTMLElement: 'https://developer.mozilla.org/docs/Web/API/HTMLElement',
  Iterable: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Iteration_protocols',
  Iterator: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Iterator',
  Map: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map',
  Object: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Object',
  Promise: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise',
  PromiseLike: 'https://github.com/Microsoft/TypeScript/blob/38c3279/src/lib/es5.d.ts#L1519',
  PropertyDescriptor: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Object/defineProperty',
  PropertyKey: 'https://www.typescriptlang.org/docs/handbook/2/keyof-types.html',
  Proxy: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Proxy',
  RegExp: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/RegExp',
  Set: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Set',
  Stats: 'https://nodejs.org/api/fs.html#class-fsstats',
  Symbol: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Symbol',
  URL: 'https://developer.mozilla.org/docs/Web/API/URL',
  WeakMap: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/WeakMap',
  WeakSet: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/WeakSet',
  WebSocket: 'https://developer.mozilla.org/docs/Web/API/WebSocket'
};
