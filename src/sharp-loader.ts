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
 *
 * The input is either bytes to draw — an SVG, a PNG — or a block `sharp` creates
 * on the spot, which is how a flat fill is composited without building an image
 * for it first.
 */
export interface SharpCompositeLayer {
  readonly input: Buffer | SharpCreateInput;
  readonly left: number;
  readonly top: number;
}

/**
 * A solid block of color, created by `sharp` rather than supplied as bytes.
 */
export interface SharpCreateInput {
  readonly create: SharpCreateSpec;
}

/**
 * The block `sharp` is asked to create: a rectangle of one flat color.
 */
export interface SharpCreateSpec {
  readonly background: SharpRgbColor;
  readonly channels: number;
  readonly height: number;
  readonly width: number;
}

/**
 * The `sharp` entry point the image helpers use.
 */
export type SharpFactory = (input: Uint8Array) => SharpInstance;

/**
 * One `sharp` pipeline.
 */
export interface SharpInstance {
  blur: (this: void, sigma: number) => SharpInstance;
  composite: (this: void, layers: SharpCompositeLayer[]) => SharpInstance;
  ensureAlpha: (this: void) => SharpInstance;
  metadata: (this: void) => Promise<SharpMetadata>;
  png: (this: void) => SharpInstance;
  raw: (this: void) => SharpInstance;
  resize: (this: void, width: number, height: number, options?: SharpResizeOptions) => SharpInstance;
  toBuffer: SharpToBuffer;
  trim: (this: void, options: SharpTrimOptions) => SharpInstance;
}

/**
 * The subset of `sharp`'s metadata the image helpers read.
 */
export interface SharpMetadata {
  readonly height?: number | undefined;
  readonly width?: number | undefined;
}

/**
 * The geometry raw pixels have to be read with — without it they are a flat run of bytes.
 */
export interface SharpRawInfo {
  readonly channels: number;
  readonly height: number;
  readonly width: number;
}

/**
 * A frame's raw pixels and the geometry they have to be read with.
 */
export interface SharpRawResult {
  readonly data: Uint8Array;
  readonly info: SharpRawInfo;
}

/**
 * The subset of `sharp`'s resize options the image helpers set.
 */
export interface SharpResizeOptions {
  readonly fit: 'cover' | 'fill';
}

/**
 * Asks `toBuffer` for the pixels AND the geometry they are to be read with.
 *
 * Literal `true` rather than `boolean`, so the overload that returns
 * {@link SharpRawResult} is only selected when the geometry is genuinely coming
 * back — a `false` would resolve to bare bytes with the width silently missing.
 */
export interface SharpResolveWithObjectOptions {
  readonly resolveWithObject: true;
}

/**
 * A color as `sharp` names its channels.
 */
export interface SharpRgbColor {
  readonly b: number;
  readonly g: number;
  readonly r: number;
}

/**
 * `sharp`'s `toBuffer`, in the two shapes the image helpers call it in.
 *
 * Written as an overloaded call signature rather than a union return, because
 * which one comes back is decided by the argument and a caller should not have
 * to narrow a result it already knows the shape of.
 */
export interface SharpToBuffer {
  (this: void): Promise<Buffer>;
  (this: void, options: SharpResolveWithObjectOptions): Promise<SharpRawResult>;
}

/**
 * The subset of `sharp`'s trim options the image helpers set.
 */
export interface SharpTrimOptions {
  /**
   * How far a pixel may differ from the trimmed-away color before it counts as
   * content.
   */
  readonly threshold: number;
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
