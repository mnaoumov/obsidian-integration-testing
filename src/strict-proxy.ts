/**
 * @file
 *
 * Strict proxy for mock objects.
 *
 * Wraps an object in a `Proxy` that throws a descriptive error when any
 * unmocked property is accessed, instead of silently returning `undefined`.
 *
 * - Idempotent (double-wrapping is a no-op).
 * - Passthrough for well-known props (`then`, `toJSON`, `Symbol.iterator`, etc.).
 * - Class-name-aware error messages for class instances.
 * - Recursive proxying of nested plain objects (for partial mocks only).
 *
 * Overloads:
 * 1. `strictProxy(value, MockClass)` — infers `T` from `MockClass.prototype`,
 *    overlays `__`-suffixed methods via the proxy.
 * 2. `strictProxy(value: T)` — infers `T` from the argument.
 * 3. `strictProxy<T>(partial)` — test mocking: typed via `PartialDeep<T>`.
 * 4. `strictProxy<T>(value)` — explicit `T`, unchecked value (cross-type cast).
 */

import type { PartialDeep } from 'type-fest';

import type { GenericObject } from './type-guards.ts';

import { ensureGenericObject } from './type-guards.ts';

const STRICT_PROXY_TARGET_SYMBOL = Symbol.for('strictProxyTarget');

const PASSTHROUGH_PROPS = new Set<string | symbol>([
  Symbol.iterator,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  'then',
  'toJSON'
]);

type MockClassLike<T> = MockClassPrototypeRef<T> & MockClassRef;

interface MockClassPrototypeRef<T> {
  prototype: T;
}

interface MockClassRef {
  name: string;
  prototype: object;
}

/**
 * Unwraps a strict-proxied object, returning the underlying target.
 *
 * Accessing unmocked properties on the returned object yields `undefined`
 * instead of throwing. Non-proxied values are returned as-is.
 *
 * @typeParam T - The type of the object.
 * @param obj - The object to unwrap.
 * @returns The underlying target, or `obj` if it is not a strict proxy.
 */
export function bypassStrictProxy<T>(obj: T): T {
  if (!isObjectLike(obj)) {
    return obj;
  }
  if (!(STRICT_PROXY_TARGET_SYMBOL in obj)) {
    return obj;
  }
  return obj[STRICT_PROXY_TARGET_SYMBOL] as T;
}

// eslint-disable-next-line @typescript-eslint/unified-signatures -- This overload infers T from mockClass; the `unknown` overload below requires explicit T. They cannot be combined.
export function strictProxy<T>(value: unknown, mockClass: MockClassLike<T>): T;
export function strictProxy<T extends object>(value: T): T;
export function strictProxy<T>(value: PartialDeep<T>): T;
// eslint-disable-next-line @typescript-eslint/unified-signatures, @typescript-eslint/no-unnecessary-type-parameters -- PartialDeep<T> above gives type safety for partial mocks; this overload accepts an explicit T with an unchecked value for cross-type casts.
export function strictProxy<T>(value: unknown): T;
/**
 * Wraps a mock object in a strict {@link Proxy} that throws on unmocked access.
 *
 * @typeParam T - The type the proxy presents.
 * @param value - The object (or partial mock) to wrap.
 * @param mockClass - Optional mock class providing `__`-suffixed overlay methods.
 * @returns The wrapped value typed as `T`.
 */
export function strictProxy<T>(value: unknown, mockClass?: MockClassRef): T {
  return wrapProxy<T>(value, mockClass);
}

/**
 * Checks whether a value is a non-`null` object.
 *
 * @param value - The value to check.
 * @returns `true` if the value is a non-`null` object.
 */
function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * Checks whether a value is a plain object (prototype is `Object.prototype`).
 *
 * @param value - The value to check.
 * @returns `true` if the value is a plain object.
 */
function isPlainObject(value: unknown): value is GenericObject {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Implements the strict-proxy wrapping logic shared by all overloads.
 *
 * @typeParam T - The type the proxy presents.
 * @param value - The object to wrap.
 * @param mockClass - Optional mock class providing `__`-suffixed overlay methods.
 * @returns The wrapped value typed as `T`.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T provides return-type inference at the call sites.
function wrapProxy<T>(value: unknown, mockClass?: MockClassRef): T {
  if (!isObjectLike(value)) {
    return value as T;
  }

  if (STRICT_PROXY_TARGET_SYMBOL in value) {
    return value as T;
  }
  Object.defineProperty(value, STRICT_PROXY_TARGET_SYMBOL, { value });

  const isClass = !isPlainObject(value);
  const className = mockClass?.name ?? (isClass ? value.constructor.name : '');
  const mockProto = mockClass ? ensureGenericObject(mockClass.prototype) : null;
  const proxiedChildren = isClass ? null : new Map<string | symbol>();

  return new Proxy(value, {
    get(target, prop, receiver): unknown {
      // 1. Own properties and prototype chain of the original object.
      if (prop in target) {
        if (proxiedChildren?.has(prop)) {
          return proxiedChildren.get(prop);
        }

        const val: unknown = Reflect.get(target, prop, receiver);
        if (proxiedChildren && isPlainObject(val)) {
          const result = wrapProxy<unknown>(val);
          proxiedChildren.set(prop, result);
          return result;
        }
        return val;
      }

      // 2. Mock prototype chain (for __ methods on the mock class).
      if (mockProto && typeof prop === 'string' && prop.endsWith('__') && prop in mockProto) {
        const val: unknown = mockProto[prop];
        if (typeof val === 'function') {
          return val.bind(receiver);
        }
        return val;
      }

      // 3. Passthrough props (symbols, then, toJSON, etc.).
      if (typeof prop === 'symbol' || PASSTHROUGH_PROPS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      throw new Error(`Property "${prop}" is not mocked in ${className}. To override, assign a value first: mock.${prop} = ...`);
    }
  }) as T;
}
