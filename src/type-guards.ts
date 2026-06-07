/**
 * @file
 *
 * Contains utility functions for type guards.
 */

/**
 * A generic object with `string` keys and `unknown` values.
 *
 * Used as a widening target for dynamic property access on mock objects.
 */
export type GenericObject = Record<string, unknown>;

type NullableConstraint<T> = null extends T ? unknown : undefined extends T ? unknown : never;

/**
 * Asserts that a value is not `null` or `undefined`, narrowing its type in place.
 *
 * Only callable when `T` includes `null` or `undefined`. Passing an already non-nullable type is a compile error.
 *
 * @typeParam T - The type of the value.
 * @param value - The value to check.
 * @param errorOrMessage - Optional {@link Error} or error message string.
 * @throws If the value is `null` or `undefined`.
 */
export function assertNonNullable<T extends NullableConstraint<T>>(value: T, errorOrMessage?: Error | string): asserts value is NonNullable<T> {
  if (value !== null && value !== undefined) {
    return;
  }

  errorOrMessage ??= value === null ? 'Value is null' : 'Value is undefined';
  const error = typeof errorOrMessage === 'string' ? new Error(errorOrMessage) : errorOrMessage;
  throw error;
}

/**
 * Casts a value to a specific type without any runtime check.
 *
 * Prefer this over inline `as` assertions: it keeps the unsafe cast in one
 * auditable place and reads as an explicit, intentional escape hatch.
 *
 * @typeParam T - The target type to cast to.
 * @param value - The value to cast.
 * @returns The value typed as `T`.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- The type parameter is the cast target; it cannot be inferred from the `unknown` argument.
export function castTo<T>(value: unknown): T {
  return value as T;
}

/**
 * Widens an object to a {@link GenericObject} so dynamic string-keyed property
 * access type-checks.
 *
 * @typeParam T - The object type.
 * @param obj - The object to widen.
 * @returns The same object typed as `GenericObject & T`.
 */
export function ensureGenericObject<T extends object>(obj: T): GenericObject & T {
  return obj as GenericObject & T;
}

/**
 * Ensures that a value is not `null` or `undefined` and returns it with narrowed type.
 *
 * Only callable when `T` includes `null` or `undefined`. Passing an already non-nullable type is a compile error.
 *
 * @typeParam T - The type of the value.
 * @param value - The value to check.
 * @param errorOrMessage - Optional {@link Error} or error message string.
 * @returns The value with `null` and `undefined` excluded from its type.
 * @throws If the value is `null` or `undefined`.
 */
export function ensureNonNullable<T extends NullableConstraint<T>>(value: T, errorOrMessage?: Error | string): NonNullable<T> {
  assertNonNullable(value, errorOrMessage);
  return value;
}
