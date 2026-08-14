/**
 * @file
 *
 * Source discovery + extraction: resolves the public API barrel to its entry files, and turns each
 * file's exported declarations into `TypeInfo` entries keyed by a qualified `${namespace}#${name}`.
 */

import type { SourceFile } from 'ts-morph';

import { createHash } from 'node:crypto';
import {
  globSync,
  readFileSync
} from 'node:fs';
import {
  relative,
  resolve
} from 'node:path';

import type { TypeInfo } from './api-doc-types.ts';

import {
  GENERIC_TYPE_PARAMS,
  PUBLIC_API_ENTRY_FILE,
  ROOT_DIR
} from './api-doc-constants.ts';
import {
  extractClassInfo,
  extractEnumInfo,
  extractInterfaceInfo,
  extractTypeAliasInfo,
  getDescription,
  getExamples,
  getParameterDescriptions,
  getRemarks,
  getReturnDescription,
  getSince
} from './api-doc-jsdoc.ts';
import { simplifyType } from './api-doc-text-utils.ts';

/**
 * One `export [type] { … } from '…';` statement of the public API barrel.
 *
 * `[^}]*` spans the newlines of a multi-line specifier list; the barrel never re-exports a nested
 * object literal, so there is no inner `}` to stop at early.
 */
const RE_EXPORT_REG_EXP = /export\s+(?:type\s+)?\{(?<specifiers>[^}]*)\}\s*from\s*'(?<moduleSpecifier>[^']+)'/g;

/**
The two halves of the public API barrel: which modules it re-exports, and which names it forwards.
*/
interface PublicApiBarrel {
  files: string[];
  names: Set<string>;
}

/**
Collect top-level exported functions.
*/
export function collectFunctions(src: SourceFile, types: Map<string, TypeInfo>, namespace: string): void {
  for (const $function of src.getFunctions()) {
    if (!$function.isExported()) {
      continue;
    }
    const name = $function.getName();
    if (!name) {
      continue;
    }
    const key = qualifiedKey(namespace, name);
    if (types.has(key)) {
      continue;
    }
    const parameterDescriptions = getParameterDescriptions($function);
    const params = $function.getParameters().map((p) => ({
      description: parameterDescriptions.get(p.getName()) ?? '',
      name: p.getName(),
      type: simplifyType(p.getType().getText())
    }));
    const parameterString = params.map((p) => `${p.name}: ${p.type}`).join(', ');
    const returnType = simplifyType($function.getReturnType().getText());
    const signature = `${name}(${parameterString})`;
    types.set(key, {
      baseTypes: [],
      description: getDescription($function),
      enumMembers: [],
      examples: getExamples($function),
      implementsTypes: [],
      kind: 'function',
      methods: [{
        description: getDescription($function),
        examples: getExamples($function),
        inheritedFrom: '',
        isStatic: false,
        name,
        overloadKey: name,
        parameters: params,
        remarks: getRemarks($function),
        returnDescription: getReturnDescription($function),
        returnType,
        signature,
        since: getSince($function),
        type: ''
      }],
      name,
      namespace,
      properties: [],
      remarks: getRemarks($function),
      typeParameters: $function.getTypeParameters().map((tp) => tp.getText())
    });
  }
}

/**
Collect top-level exported variable declarations (e.g. `export const EMPTY = ''`).
*/
export function collectVariables(src: SourceFile, types: Map<string, TypeInfo>, namespace: string): void {
  for (const variableStatement of src.getVariableStatements()) {
    if (!variableStatement.isExported()) {
      continue;
    }
    const declarationKind = variableStatement.getDeclarationKind();
    for (const declaration of variableStatement.getDeclarations()) {
      const name = declaration.getName();
      const key = qualifiedKey(namespace, name);
      if (!name || types.has(key)) {
        continue;
      }
      types.set(key, {
        baseTypes: [],
        description: getDescription(variableStatement),
        enumMembers: [],
        examples: getExamples(variableStatement),
        implementsTypes: [],
        kind: 'variable',
        methods: [],
        name,
        namespace,
        properties: [],
        remarks: getRemarks(variableStatement),
        typeParameters: [],
        variableKeyword: declarationKind,
        variableType: simplifyType(declaration.getType().getText())
      });
    }
  }
}

/**
Compute a hash of all entry source files + the public API barrel + the generator scripts themselves
*/
export function computeCacheHash(entryFiles: string[]): string {
  const hash = createHash('sha256');

  // Hash the generator script itself
  const generatorPath = resolve(import.meta.dirname, '..', 'generate-api-docs.ts');
  hash.update(readFileSync(generatorPath, 'utf-8'));

  /*
   * Hash the barrel — it decides both which files are entries and which of their names are public,
   * so a re-export added or removed there changes the output even when no entry file changed.
   */
  hash.update(readFileSync(PUBLIC_API_ENTRY_FILE, 'utf-8'));

  // Hash all helper modules
  const helperFiles = globSync('scripts/docs-gen/helpers/**/*.ts', { cwd: ROOT_DIR }).sort();
  for (const helperFile of helperFiles) {
    const fullPath = resolve(ROOT_DIR, helperFile);
    hash.update(fullPath);
    hash.update(readFileSync(fullPath, 'utf-8'));
  }

  // Hash all entry source files
  for (const filePath of [...entryFiles].sort()) {
    hash.update(filePath);
    hash.update(readFileSync(filePath, 'utf-8'));
  }

  return hash.digest('hex');
}

/**
Compute the namespace (POSIX path relative to `src`, no extension) for a source file.
*/
export function computeNamespace(srcDirectory: string, filePath: string): string {
  return relative(srcDirectory, filePath).replaceAll('\\', '/').replace(/\.ts$/, '');
}

/**
 * The documentable entry files: the modules `src/index.ts` re-exports from.
 *
 * Unlike a subpath-per-module library, this package publishes exactly one API entry point, so "public"
 * is defined by the barrel rather than by the file layout — `src` also holds the co-located `*.test.ts`
 * / `*.integration.test.ts` suites and modules that exist only for the runner adapters. Walking `src`
 * would document all of those; following the barrel documents precisely what a consumer can import.
 *
 * @param directory - The `src` directory the barrel's relative specifiers resolve against.
 * @returns The absolute paths of the re-exported modules, in barrel order, deduplicated.
 */
export function findEntryFiles(directory: string): string[] {
  return readPublicApiBarrel(directory).files;
}

/**
 * The names `src/index.ts` re-exports, which is the exact set of documentable declarations.
 *
 * A re-exported module normally exports more than the barrel forwards (helpers shared with its
 * siblings, symbols used by the runner adapters); those are internal and must not reach the reference.
 *
 * @param directory - The `src` directory the barrel's relative specifiers resolve against.
 * @returns Every publicly re-exported name, as written at the import site (so an `X as Y` yields `Y`).
 */
export function findPublicApiNames(directory: string): Set<string> {
  return readPublicApiBarrel(directory).names;
}

export function processSourceFile(src: SourceFile, types: Map<string, TypeInfo>, namespace: string): void {
  for (const alias of src.getTypeAliases()) {
    if (!alias.isExported()) {
      continue;
    }
    const key = qualifiedKey(namespace, alias.getName());
    if (!types.has(key)) {
      types.set(key, extractTypeAliasInfo(alias, namespace));
    }
  }

  for (const enumDeclaration of src.getEnums()) {
    if (!enumDeclaration.isExported()) {
      continue;
    }
    const key = qualifiedKey(namespace, enumDeclaration.getName());
    if (!types.has(key)) {
      types.set(key, extractEnumInfo(enumDeclaration, namespace));
    }
  }

  for (const iface of src.getInterfaces()) {
    if (!iface.isExported()) {
      continue;
    }
    const key = qualifiedKey(namespace, iface.getName());
    if (!types.has(key)) {
      types.set(key, extractInterfaceInfo(iface, namespace));
    }
  }

  for (const cls of src.getClasses()) {
    if (!cls.isExported()) {
      continue;
    }
    const name = cls.getName();
    if (!name) {
      continue;
    }
    const key = qualifiedKey(namespace, name);
    if (!types.has(key)) {
      types.set(key, extractClassInfo(cls, namespace));
    }
  }
}

/**
 * Register all type parameter names so renderTypeWithLinks won't hyperlink them.
 * Skip names that are also known types — those should still be linkable.
 */
export function registerGenericTypeParams(types: Map<string, TypeInfo>): void {
  const knownNames = new Set<string>();
  for (const [, info] of types) {
    knownNames.add(info.name);
  }
  for (const [, info] of types) {
    for (const tp of info.typeParameters) {
      const bareParameter = tp.replace(/\s+extends\s+.*$/, '');
      if (!knownNames.has(bareParameter)) {
        GENERIC_TYPE_PARAMS.add(bareParameter);
      }
    }
  }
}

function qualifiedKey(namespace: string, name: string): string {
  return `${namespace}#${name}`;
}

/**
 * Parse `src/index.ts` into the modules it re-exports and the names it forwards.
 *
 * The barrel is plain `export [type] { … } from './module.ts';` statements — read with a regex rather
 * than ts-morph because this runs before the ts-morph project exists (the cache-hash check needs the
 * entry file list first, and a cache hit must not pay for loading the program).
 */
function readPublicApiBarrel(srcDirectory: string): PublicApiBarrel {
  const barrel = readFileSync(PUBLIC_API_ENTRY_FILE, 'utf-8');
  const files = new Set<string>();
  const names = new Set<string>();

  for (const match of barrel.matchAll(RE_EXPORT_REG_EXP)) {
    const moduleSpecifier = match.groups?.['moduleSpecifier'];
    const specifiers = match.groups?.['specifiers'];
    if (moduleSpecifier === undefined || specifiers === undefined) {
      continue;
    }

    files.add(resolve(srcDirectory, moduleSpecifier));
    for (const specifier of specifiers.split(',')) {
      const exportedName = specifier.trim().split(/\s+as\s+/).at(-1)?.trim();
      if (exportedName) {
        names.add(exportedName);
      }
    }
  }

  return { files: [...files], names };
}
