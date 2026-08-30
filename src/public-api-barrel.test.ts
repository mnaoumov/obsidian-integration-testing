/**
 * @file
 *
 * Guards the hand-maintained public API barrel (`src/index.ts`, see **L2**): every type a re-exported
 * signature mentions must itself be re-exported, or consumers can call the function but cannot name what
 * it takes or returns — and the API reference (**L35**) silently omits it.
 */

import type {
  ClassDeclaration,
  ExportedDeclarations,
  Node as TsMorphNode,
  TypeReferenceNode
} from 'ts-morph';

import { readFileSync } from 'node:fs';
import {
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

const ROOT_DIR = resolve(import.meta.dirname, '..');
const SRC_DIR = toPosixPath(resolve(ROOT_DIR, 'src'));
const BARREL_PATH = resolve(SRC_DIR, 'index.ts');
const TS_CONFIG_PATH = resolve(ROOT_DIR, 'tsconfig.json');

// Building a ts-morph Project over the whole `tsconfig.json` takes a couple of seconds, and it loses the
// CPU race when the full unit suite runs in parallel — the same reason `unit-tests:docs-generator` raises
// Its timeout.
const BIG_TIMEOUT_IN_MILLISECONDS = 30_000;

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

describe('public API barrel', () => {
  it('should re-export every type mentioned by a public signature', { timeout: BIG_TIMEOUT_IN_MILLISECONDS }, () => {
    const barrel = readPublicApiBarrel();
    const project = new Project({ tsConfigFilePath: TS_CONFIG_PATH });
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
