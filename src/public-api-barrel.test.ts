/**
 * @file
 *
 * Guards the hand-maintained public API barrel (`src/index.ts`, see **L2**) in both directions.
 *
 * Outward: every type a re-exported signature mentions must itself be re-exported, or consumers can call
 * the function but cannot name what it takes or returns — and the API reference (**L35**) silently omits
 * it.
 *
 * Inward: every `src/` module must be reachable from something this package actually ships. A module
 * nothing imports and no entry point names is invisible to every other gate here — it type-checks, it
 * lints, it builds, and it is dead. Two modules had already fallen through that gap when this second
 * assertion was written (T812): `obsidian-namespace.ts`, a public-looking type mirror that was never once
 * re-exported, and `native-dialog-monitor.ts`, orphaned when `d65aa6a` retired its only caller.
 */

import type {
  ClassDeclaration,
  ExportedDeclarations,
  Node as TsMorphNode,
  TypeReferenceNode
} from 'ts-morph';

import { readFileSync } from 'node:fs';
import {
  dirname,
  relative,
  resolve
} from 'node:path';
import {
  Node,
  Project,
  SyntaxKind
} from 'ts-morph';
import {
  describe,
  expect,
  it
} from 'vitest';

/**
 * One `export [type] { … } from '…';` statement of the barrel.
 *
 * `[^}]*` spans the newlines of a multi-line specifier list; the barrel never re-exports a nested object
 * literal, so there is no inner `}` to stop at early. Deliberately the same shape as the docs generator's
 * `RE_EXPORT_REG_EXP` — that generator defines "public" the same way this test does.
 */
const RE_EXPORT_REG_EXP = /export\s+(?:type\s+)?\{(?<specifiers>[^}]*)\}\s*from\s*'(?<moduleSpecifier>[^']+)'/g;

/**
 * A repo-relative `dist/` path, split into the `src/` module it was built from.
 *
 * `package.json` names shipped entry points by their build output, so every subpath has to be mapped back
 * across the build to be checked against the sources. The extension alternation covers both module
 * formats and both declaration formats the build emits.
 */
const DIST_PATH_REG_EXP = /^dist\/lib\/(?:cjs|esm)\/(?<relativePath>.+?)\.(?:cjs|mjs|d\.cts|d\.mts)$/;

/**
 * The module specifier a `bin/` shim imports its implementation from — the one hop between
 * `package.json`'s `bin` map and the built module it ultimately runs.
 */
const BIN_IMPORT_REG_EXP = /from\s*'(?<moduleSpecifier>[^']+)'/g;

const LEADING_DOT_SLASH_REG_EXP = /^\.\//;

const ROOT_DIR = resolve(import.meta.dirname, '..');
const SRC_DIR = toPosixPath(resolve(ROOT_DIR, 'src'));
const BARREL_PATH = resolve(SRC_DIR, 'index.ts');
const PACKAGE_JSON_PATH = resolve(ROOT_DIR, 'package.json');
const TS_CONFIG_PATH = resolve(ROOT_DIR, 'tsconfig.json');

// Building a ts-morph Project over the whole `tsconfig.json` takes a couple of seconds, and it loses the
// CPU race when the full unit suite runs in parallel — the same reason `unit-tests:docs-generator` raises
// Its timeout.
// `test:coverage` makes that far worse: v8 instrumentation slows the very same load by roughly 10x (3.1 s
// Plain, past 30 s instrumented), so this budget has to clear the instrumented cost, not the plain one.
const BIG_TIMEOUT_IN_MILLISECONDS = 120_000;

/**
 * One node of `package.json`'s `exports` tree: a built file, or a nested condition map leading to one.
 */
type ExportsCondition = ExportsConditionMap | string;

/**
 * A nested `exports` condition map (`import` / `require` / `types` / …).
 *
 * An interface rather than a `Record<string, ExportsCondition>`, because TypeScript resolves a mapped type
 * eagerly and rejects the recursion (`TS2456`) — an interface's members are deferred.
 */
interface ExportsConditionMap {
  [condition: string]: ExportsCondition;
}

/**
 * The `package.json` maps that name a shipped entry point — the modules a consumer reaches without any
 * `src/` module importing them, which is what makes them roots rather than orphans.
 */
interface PackageEntryPoints {
  bin?: Record<string, string>;
  exports?: ExportsConditionMap;
}

/**
 * The barrel's two halves: which modules it re-exports from, and which names it forwards.
 */
interface PublicApiBarrel {
  entryFilePaths: string[];
  names: Set<string>;
}

/**
 * A type a public signature mentions that the barrel does not re-export.
 */
interface UnexportedTypeReference {
  publicName: string;
  referencedTypeName: string;
  sourceFilePath: string;
}

// Both assertions load the same project; building it twice would double the most expensive thing in this
// File. See `getProject`.
let cachedProject: Project | undefined;

describe('public API barrel', () => {
  it('should re-export every type mentioned by a public signature', { timeout: BIG_TIMEOUT_IN_MILLISECONDS }, () => {
    const barrel = readPublicApiBarrel();
    const project = getProject();
    const unexportedTypeReferences: UnexportedTypeReference[] = [];

    for (const entryFilePath of barrel.entryFilePaths) {
      const sourceFile = project.getSourceFile(entryFilePath);
      if (!sourceFile) {
        throw new Error(`The barrel re-exports from '${entryFilePath}', which is not part of the TypeScript project.`);
      }

      for (const [publicName, declarations] of sourceFile.getExportedDeclarations()) {
        if (!barrel.names.has(publicName)) {
          continue;
        }

        for (const declaration of declarations) {
          for (const referencedTypeName of collectUnexportedTypeNames(declaration, barrel.names)) {
            unexportedTypeReferences.push({
              publicName,
              referencedTypeName,
              sourceFilePath: toRelativePath(sourceFile.getFilePath())
            });
          }
        }
      }
    }

    expect(unexportedTypeReferences.map((unexportedTypeReference) => formatUnexportedTypeReference(unexportedTypeReference)).sort()).toEqual([]);
  });

  it('should leave no module unreachable from a shipped entry point', { timeout: BIG_TIMEOUT_IN_MILLISECONDS }, () => {
    const project = getProject();
    const reachableFilePaths = collectReachableFilePaths(project, readRootFilePaths(project));

    const orphanFilePaths = project.getSourceFiles()
      .map((sourceFile) => sourceFile.getFilePath())
      .filter((filePath) => filePath.startsWith(`${SRC_DIR}/`) && !reachableFilePaths.has(filePath))
      .map((filePath) => toRelativePath(filePath))
      .sort();

    expect(orphanFilePaths).toEqual([]);
  });
});

/**
 * The signature nodes of a class: what it extends/implements, plus the types of its non-`private`,
 * non-`protected` members — a consumer can reach exactly those.
 *
 * @param classDeclaration - The re-exported class.
 * @returns The signature-position nodes to scan for type references.
 */
function collectClassSignatureNodes(classDeclaration: ClassDeclaration): TsMorphNode[] {
  const signatureNodes: TsMorphNode[] = [...classDeclaration.getHeritageClauses()];

  for (const member of [...classDeclaration.getConstructors(), ...classDeclaration.getMethods()]) {
    if (isHiddenMember(member.getScope())) {
      continue;
    }
    for (const parameter of member.getParameters()) {
      const typeNode = parameter.getTypeNode();
      if (typeNode) {
        signatureNodes.push(typeNode);
      }
    }
    const returnTypeNode = Node.isMethodDeclaration(member) ? member.getReturnTypeNode() : undefined;
    if (returnTypeNode) {
      signatureNodes.push(returnTypeNode);
    }
  }

  for (const property of classDeclaration.getProperties()) {
    if (isHiddenMember(property.getScope())) {
      continue;
    }
    const typeNode = property.getTypeNode();
    if (typeNode) {
      signatureNodes.push(typeNode);
    }
  }

  return signatureNodes;
}

/**
 * Every built file `package.json`'s `exports` tree points at, flattened out of its condition maps.
 *
 * @param exportsCondition - The `exports` node to flatten.
 * @param distPaths - The set to collect the repo-relative `dist/` paths into.
 */
function collectDistPaths(exportsCondition: ExportsCondition, distPaths: Set<string>): void {
  if (typeof exportsCondition === 'string') {
    distPaths.add(exportsCondition.replace(LEADING_DOT_SLASH_REG_EXP, ''));
    return;
  }

  for (const nestedCondition of Object.values(exportsCondition)) {
    collectDistPaths(nestedCondition, distPaths);
  }
}

/**
 * Every file reachable from the roots by following module specifiers, transitively.
 *
 * `getReferencedSourceFiles()` covers static imports, re-exports, dynamic `import()` and `import()` type
 * nodes alike — all of them resolved, so a specifier that names a package rather than a local module
 * simply contributes nothing.
 *
 * @param project - The ts-morph project to resolve modules against.
 * @param rootFilePaths - The entry points to walk out from.
 * @returns The reachable file paths, the roots included.
 */
function collectReachableFilePaths(project: Project, rootFilePaths: string[]): Set<string> {
  const reachableFilePaths = new Set<string>();
  const pendingFilePaths = [...rootFilePaths];

  while (pendingFilePaths.length > 0) {
    const filePath = pendingFilePaths.pop();
    if (filePath === undefined || reachableFilePaths.has(filePath)) {
      continue;
    }
    reachableFilePaths.add(filePath);

    for (const referencedSourceFile of project.getSourceFile(filePath)?.getReferencedSourceFiles() ?? []) {
      pendingFilePaths.push(referencedSourceFile.getFilePath());
    }
  }

  return reachableFilePaths;
}

/**
 * The nodes that make up a declaration's public signature — never its implementation body, whose local
 * types are internal by construction.
 *
 * @param declaration - The re-exported declaration to inspect.
 * @returns The signature-position nodes to scan for type references.
 */
function collectSignatureNodes(declaration: ExportedDeclarations): TsMorphNode[] {
  if (Node.isFunctionDeclaration(declaration)) {
    const returnTypeNode = declaration.getReturnTypeNode();
    return [
      ...declaration.getParameters().map((parameter) => parameter.getTypeNode()),
      returnTypeNode
    ].filter((node) => !!node);
  }

  if (Node.isTypeAliasDeclaration(declaration)) {
    return [declaration.getTypeNodeOrThrow()];
  }

  if (Node.isInterfaceDeclaration(declaration)) {
    return [declaration];
  }

  if (Node.isClassDeclaration(declaration)) {
    return collectClassSignatureNodes(declaration);
  }

  if (Node.isVariableDeclaration(declaration)) {
    const typeNode = declaration.getTypeNode();
    return typeNode ? [typeNode] : [];
  }

  return [];
}

/**
 * Every type reference in a signature node, including the node itself when it is one.
 *
 * @param signatureNode - The signature-position node to scan.
 * @returns The type references it contains.
 */
function collectTypeReferences(signatureNode: TsMorphNode): TypeReferenceNode[] {
  const typeReferences = signatureNode.getDescendantsOfKind(SyntaxKind.TypeReference);
  if (Node.isTypeReference(signatureNode)) {
    typeReferences.push(signatureNode);
  }
  return typeReferences;
}

/**
 * Every locally declared type name a public declaration's signature mentions but the barrel does not
 * re-export.
 *
 * @param declaration - The re-exported declaration to inspect.
 * @param publicNames - The names the barrel re-exports.
 * @returns The offending type names, deduplicated.
 */
function collectUnexportedTypeNames(declaration: ExportedDeclarations, publicNames: Set<string>): Set<string> {
  const unexportedTypeNames = new Set<string>();

  for (const signatureNode of collectSignatureNodes(declaration)) {
    for (const typeReference of collectTypeReferences(signatureNode)) {
      // A qualified `Foo.Bar` is owned by `Foo`, which is the name a consumer has to be able to import.
      const referencedTypeName = typeReference.getTypeName().getText().split('.', 1)[0] ?? '';
      if (!referencedTypeName || publicNames.has(referencedTypeName)) {
        continue;
      }

      if (isDeclaredInSrc(typeReference)) {
        unexportedTypeNames.add(referencedTypeName);
      }
    }
  }

  return unexportedTypeNames;
}

/**
 * Formats one offending reference for the assertion message.
 *
 * @param unexportedTypeReference - The offending reference.
 * @returns A single line naming the type, the public name that leaks it, and where.
 */
function formatUnexportedTypeReference(unexportedTypeReference: UnexportedTypeReference): string {
  return `${unexportedTypeReference.referencedTypeName} (mentioned by ${unexportedTypeReference.publicName} in ${unexportedTypeReference.sourceFilePath})`;
}

/**
 * The ts-morph project over the whole `tsconfig.json`, built at most once per run.
 *
 * Loading it is the single most expensive thing in this file — the reason for the timeout above — and both
 * assertions need the same one, so it is memoized rather than built per test.
 *
 * @returns The shared project.
 */
function getProject(): Project {
  cachedProject ??= new Project({ tsConfigFilePath: TS_CONFIG_PATH });
  return cachedProject;
}

/**
 * Whether a type reference resolves to a declaration of this package's own `src/` (its tests aside), which
 * is what makes it a name the barrel is responsible for.
 *
 * Import aliases are followed first: without that, `import type { Browser } from 'webdriverio'` resolves to
 * the `import` statement in `src/`, and every third-party type would look local.
 *
 * @param typeReference - The type reference to resolve.
 * @returns `true` when the type is declared in this package's `src/`.
 */
function isDeclaredInSrc(typeReference: TypeReferenceNode): boolean {
  const symbol = typeReference.getTypeName().getSymbol();
  if (!symbol) {
    return false;
  }

  const resolvedSymbol = symbol.getAliasedSymbol() ?? symbol;

  return resolvedSymbol.getDeclarations().some((declaration) => {
    // A generic type parameter is scoped to the declaration that introduces it — never a barrel entry.
    if (Node.isTypeParameterDeclaration(declaration)) {
      return false;
    }
    const filePath = declaration.getSourceFile().getFilePath();
    return filePath.startsWith(`${SRC_DIR}/`) && !filePath.endsWith('.test.ts');
  });
}

/**
 * Whether a member's scope hides it from consumers.
 *
 * @param scope - The member's scope.
 * @returns `true` when the member is `private` or `protected`.
 */
function isHiddenMember(scope: string): boolean {
  return scope === 'private' || scope === 'protected';
}

/**
 * Parses `src/index.ts` into the modules it re-exports from and the names it forwards.
 *
 * @returns The barrel's entry file paths (deduplicated, in barrel order) and re-exported names.
 */
function readPublicApiBarrel(): PublicApiBarrel {
  const barrelText = readFileSync(BARREL_PATH, 'utf-8');
  const entryFilePaths = new Set<string>();
  const names = new Set<string>();

  for (const match of barrelText.matchAll(RE_EXPORT_REG_EXP)) {
    const moduleSpecifier = match.groups?.['moduleSpecifier'] ?? '';
    entryFilePaths.add(resolve(SRC_DIR, moduleSpecifier));

    for (const specifier of (match.groups?.['specifiers'] ?? '').split(',')) {
      const trimmedSpecifier = specifier.trim();
      if (!trimmedSpecifier) {
        continue;
      }
      // `X as Y` is imported by consumers as `Y`.
      const aliasParts = trimmedSpecifier.split(/\s+as\s+/);
      names.add((aliasParts[1] ?? aliasParts[0] ?? '').trim());
    }
  }

  return {
    entryFilePaths: [...entryFilePaths],
    names
  };
}

/**
 * Every module a consumer can reach without another `src/` module importing it: the barrel, every
 * `exports` subpath, whatever the `bin` shims run, and the test files the runner loads directly.
 *
 * Derived from `package.json` rather than listed here on purpose — a hand-written root list is the same
 * kind of unchecked mirror this assertion exists to catch.
 *
 * @param project - The ts-morph project the roots must resolve within.
 * @returns The root file paths, deduplicated.
 */
function readRootFilePaths(project: Project): string[] {
  const packageEntryPoints = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageEntryPoints;
  const distPaths = new Set<string>();

  collectDistPaths(packageEntryPoints.exports ?? {}, distPaths);

  for (const binFilePath of Object.values(packageEntryPoints.bin ?? {})) {
    const binAbsolutePath = resolve(ROOT_DIR, binFilePath);
    for (const match of readFileSync(binAbsolutePath, 'utf-8').matchAll(BIN_IMPORT_REG_EXP)) {
      const moduleSpecifier = match.groups?.['moduleSpecifier'] ?? '';
      const importedAbsolutePath = resolve(dirname(binAbsolutePath), moduleSpecifier);
      distPaths.add(toPosixPath(relative(ROOT_DIR, importedAbsolutePath)));
    }
  }

  const rootFilePaths = new Set<string>([toPosixPath(BARREL_PATH)]);

  for (const distPath of distPaths) {
    rootFilePaths.add(resolveSourceFilePath(distPath, project));
  }

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (filePath.startsWith(`${SRC_DIR}/`) && filePath.endsWith('.test.ts')) {
      rootFilePaths.add(filePath);
    }
  }

  return [...rootFilePaths];
}

/**
 * Maps a shipped `dist/` path back across the build to the `src/` module it was compiled from.
 *
 * Throws rather than skipping: a shipped entry point that no longer maps to a source file is a broken
 * `package.json`, and silently dropping it would let everything it reaches read as orphaned.
 *
 * @param distPath - The repo-relative `dist/` path to map back.
 * @param project - The ts-morph project the module must exist in.
 * @returns The absolute, forward-slashed path of the source module.
 */
function resolveSourceFilePath(distPath: string, project: Project): string {
  const relativePath = DIST_PATH_REG_EXP.exec(distPath)?.groups?.['relativePath'];
  if (!relativePath) {
    throw new Error(`'package.json' ships '${distPath}', which is not a path this build's output can produce.`);
  }

  // A declaration-only subpath (`./vitest/typings`) has no `.ts` sibling — its source IS the `.d.ts`.
  for (const extension of ['.ts', '.d.ts']) {
    const candidateFilePath = toPosixPath(resolve(SRC_DIR, `${relativePath}${extension}`));
    if (project.getSourceFile(candidateFilePath)) {
      return candidateFilePath;
    }
  }

  throw new Error(`'package.json' ships '${distPath}', which no module under 'src/' builds.`);
}

/**
 * Normalizes a path to forward slashes, the form ts-morph reports file paths in.
 *
 * @param path - The path to normalize.
 * @returns The path with forward slashes.
 */
function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * Formats an absolute path relative to the repo root, for a readable assertion message.
 *
 * @param path - The absolute path.
 * @returns The repo-relative, forward-slashed path.
 */
function toRelativePath(path: string): string {
  return toPosixPath(relative(ROOT_DIR, path));
}
