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
 * @param object - The object to unwrap.
 * @returns The underlying target, or `object` if it is not a strict proxy.
 */
export function bypassStrictProxy<T>(object: T): T {
  if (!isObjectLike(object)) {
    return object;
  }
  // eslint-disable-next-line unicorn/no-computed-property-existence-check -- `in` is required, not a shorthand: `object` may be a strict proxy, and only `in` routes through its `has` trap. `Object.hasOwn` would ask the target for an own descriptor and miss the marker.
  if (!(STRICT_PROXY_TARGET_SYMBOL in object)) {
    return object;
  }
  return object[STRICT_PROXY_TARGET_SYMBOL] as T;
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

  // eslint-disable-next-line unicorn/no-computed-property-existence-check -- `in` is required, not a shorthand: `value` may already be a strict proxy, and only `in` routes through its `has` trap. `Object.hasOwn` would ask the target for an own descriptor and re-wrap an already-wrapped value.
  if (STRICT_PROXY_TARGET_SYMBOL in value) {
    return value as T;
  }
  Object.defineProperty(value, STRICT_PROXY_TARGET_SYMBOL, { value });

  const isClass = !isPlainObject(value);
  const className = mockClass?.name ?? (isClass ? value.constructor.name : '');
  const mockPrototype = mockClass ? ensureGenericObject(mockClass.prototype) : null;
  const proxiedChildren = isClass ? null : new Map<string | symbol>();

  return new Proxy(value, {
    get(target, property, receiver): unknown {
      // 1. Own properties and prototype chain of the original object.
      // eslint-disable-next-line unicorn/no-computed-property-existence-check -- Walking the PROTOTYPE CHAIN is the point, as the comment above says: inherited methods must resolve through the proxy. `Object.hasOwn` would see only own properties and send every inherited member down the "not mocked" path.
      if (property in target) {
        if (proxiedChildren?.has(property)) {
          return proxiedChildren.get(property);
        }

        const value_: unknown = Reflect.get(target, property, receiver);
        if (proxiedChildren && isPlainObject(value_)) {
          const result = wrapProxy<unknown>(value_);
          proxiedChildren.set(property, result);
          return result;
        }
        return value_;
      }

      // 2. Mock prototype chain (for __ methods on the mock class).
      // eslint-disable-next-line unicorn/no-computed-property-existence-check -- Walking the mock's PROTOTYPE CHAIN is the point: a `__` method inherited from a mock base class has to resolve here, and `Object.hasOwn` would only see the leaf class's own members.
      if (mockPrototype && typeof property === 'string' && property.endsWith('__') && property in mockPrototype) {
        const value_: unknown = mockPrototype[property];
        if (typeof value_ === 'function') {
          return value_.bind(receiver);
        }
        return value_;
      }

      // 3. Passthrough props (symbols, then, toJSON, etc.).
      if (typeof property === 'symbol' || PASSTHROUGH_PROPS.has(property)) {
        return Reflect.get(target, property, receiver);
      }

      throw new Error(`Property "${property}" is not mocked in ${className}. To override, assign a value first: mock.${property} = ...`);
    }
  }) as T;
}
