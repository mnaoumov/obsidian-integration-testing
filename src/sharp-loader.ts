/**
 * @file
 *
 * Lazily loads `sharp`, the OPTIONAL peer dependency the image helpers need, and
 * describes the slice of its surface they use.
 *
 * The load is deferred because a static import would drag `sharp`'s
 * platform-specific native binaries into every consumer of this package's index,
 * when only screenshot post-processing needs them. The type is structural for
 * the same reason: this module type-checks without `sharp`'s own types being
 * resolvable.
 */

/**
 * A layer passed to `sharp`'s `composite`.
 */
export interface SharpCompositeLayer {
  readonly input: Buffer;
  readonly left: number;
  readonly top: number;
}

/**
 * The `sharp` entry point the image helpers use.
 */
export type SharpFactory = (input: Uint8Array) => SharpInstance;

/**
 * One `sharp` pipeline.
 */
export interface SharpInstance {
  blur(this: void, sigma: number): SharpInstance;
  composite(this: void, layers: SharpCompositeLayer[]): SharpInstance;
  metadata(this: void): Promise<SharpMetadata>;
  png(this: void): SharpInstance;
  resize(this: void, width: number, height: number, options?: SharpResizeOptions): SharpInstance;
  toBuffer(this: void): Promise<Buffer>;
}

/**
 * The subset of `sharp`'s metadata the image helpers read.
 */
export interface SharpMetadata {
  readonly height?: number | undefined;
  readonly width?: number | undefined;
}

/**
 * The subset of `sharp`'s resize options the image helpers set.
 */
export interface SharpResizeOptions {
  readonly fit: 'cover' | 'fill';
}

/**
 * Loads `sharp` on demand.
 *
 * @param caller - Name of the calling helper, so the error says which one needs it.
 * @returns A {@link Promise} that resolves to the `sharp` factory.
 * @throws Error naming the missing optional peer dependency.
 */
export async function importSharp(caller: string): Promise<SharpFactory> {
  try {
    // eslint-disable-next-line no-restricted-syntax -- `sharp` is an OPTIONAL peer, so it must be loaded lazily: a static import would drag its native binaries into every consumer of this package's index.
    const sharpModule = await import('sharp');
    const factory: unknown = sharpModule.default;
    return factory as SharpFactory;
  } catch (error: unknown) {
    /* v8 ignore start -- Reached only when the optional peer is absent, which it never is in this package's own test run. */
    throw new Error(
      `${caller} needs the optional peer dependency "sharp". `
        + 'Install it in the consuming project (npm i -D sharp).',
      { cause: error }
    );
    /* v8 ignore stop */
  }
}
