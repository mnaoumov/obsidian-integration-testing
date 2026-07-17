/**
 * @file
 *
 * Type-only helper for building objects with optional-but-not-`undefined`
 * properties under `exactOptionalPropertyTypes`. Ported from
 * `obsidian-dev-utils/object-utils` rather than depended on, keeping the harness
 * free of an `obsidian-dev-utils` runtime dependency (the same dependency-hygiene
 * reason the trusted-input helpers are duplicated — see the project `AGENTS.md`).
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
 * @param obj - The object literal, permitting explicit `undefined` for optional properties.
 * @returns The same object, typed as `T`.
 */
export function normalizeOptionalProperties<T>(obj: UndefinedOnPartialDeep<T>): T {
  return obj as T;
}
