/**
 * @file
 *
 * Type-only helper for building objects with optional-but-not-`undefined`
 * properties under `exactOptionalPropertyTypes`. A local copy of
 * `@mnaoumov/typescript-lib`'s `object-utils` helper of the same name rather than
 * an import, because that library is only a development dependency here (the
 * `scripts/` tooling uses it) and the published package takes no runtime
 * dependency on it — see the project `AGENTS.md` L25.
 */

import type { UndefinedOnPartialDeep } from 'type-fest';

/**
 * Lets an object literal set optional properties to `undefined` and still satisfy
 * the target type under `exactOptionalPropertyTypes` (which otherwise forbids
 * assigning `undefined` to a `prop?: T` property). This replaces the verbose
 * per-key conditional-spread idiom (`...(x !== undefined && { key: x })`) with a
 * flat `{ key: x }` literal.
 *
 * The `undefined`-valued keys remain present at runtime; every consumer of these
 * option bags reads each field with an `x?.key ?? default` / `x?.key !== undefined`
 * guard, so an explicit `undefined` value is indistinguishable from an absent key.
 *
 * @typeParam T - The target type with optional properties to normalize.
 * @param object - The object literal, permitting explicit `undefined` for optional properties.
 * @returns The same object, typed as `T`.
 */
export function normalizeOptionalProperties<T>(object: UndefinedOnPartialDeep<T>): T {
  return object as T;
}
