/**
 * @file
 *
 * Rewrites every header checksum of a tar archive as seven zero-padded octal
 * digits, so Android's toybox `tar` accepts what the host `tar` wrote.
 *
 * Toybox accepts a checksum field only when its first byte is `'0'` or `' '`.
 * bsdtar (the Windows `tar.exe`) writes six octal digits, then NUL and space, so
 * a header whose byte sum reaches `0o100000` (32768) gets a field starting with
 * `'1'` and toybox stops with `tar: bad header`. A long non-ASCII path is what
 * reaches it: Cyrillic bytes are `0xD0`-`0xD1`, so a few hundred of them in the
 * name, prefix and pax fields are enough. Seven digits plus NUL is the same
 * value in a form both tools read.
 *
 * The archive is walked header by header, using each entry's size to skip its
 * data, and never by scanning blocks: a data block can hold anything, including
 * bytes that look like a header. Each header's stored checksum is checked before
 * it is rewritten, so a walk that lost its place fails at once instead of
 * corrupting the archive.
 *
 * Kept separate from the integration-only `transport-appium` (excluded from unit
 * tests) so the walk stays unit-testable.
 */

import {
  createReadStream,
  createWriteStream
} from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/**
 * Parameters for {@link gzipTarForToybox}.
 */
export interface GzipTarForToyboxParams {
  /**
   * The uncompressed tar archive to read.
   */
  readonly sourcePath: string;

  /**
   * Where to write the gzipped archive with every checksum rewritten.
   */
  readonly targetPath: string;
}

/**
 * The size of a tar block, and of a header.
 */
export const TAR_BLOCK_SIZE_IN_BYTES = 512;

const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const CHECKSUM_DIGIT_COUNT = 7;
const OCTAL_RADIX = 8;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const BASE_256_FLAG = 0x80;
const BYTE_RADIX = 256;
const SPACE = 0x20;
const NUL = 0;
const DIGIT_ZERO = 0x30;
const DIGIT_SEVEN = 0x37;

/**
 * Computes a header's checksum: the sum of its bytes, with the checksum field
 * counted as eight spaces.
 *
 * @param header - The 512-byte header.
 * @returns The checksum.
 */
export function computeTarHeaderChecksum(header: Uint8Array): number {
  let sum = 0;
  for (const [index, byte] of header.subarray(0, TAR_BLOCK_SIZE_IN_BYTES).entries()) {
    const isChecksumByte = index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_LENGTH;
    sum += isChecksumByte ? SPACE : byte;
  }
  return sum;
}

/**
 * Creates a stream that passes a tar archive through, rewriting every header's
 * checksum as seven zero-padded octal digits plus NUL.
 *
 * It fails when a header's stored checksum does not match its bytes, and when
 * the archive ends inside a header or an entry's data.
 *
 * @returns The transform stream.
 */
export function createTarChecksumNormalizer(): Transform {
  let pending = Buffer.alloc(0);
  let dataBytesLeft = 0;
  let headerCount = 0;

  return new Transform({
    flush(callback): void {
      if (pending.length > 0 || dataBytesLeft > 0) {
        callback(
          new Error(
            `The tar archive is truncated: it ends ${dataBytesLeft > 0 ? `${String(dataBytesLeft)} byte(s) short of an entry's data` : `inside a header (${String(pending.length)} of 512 bytes)`} after ${String(headerCount)} header(s).`
          )
        );
        return;
      }
      callback();
    },
    transform(chunk: Buffer, _encoding, callback): void {
      const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      try {
        while (offset < buffer.length) {
          if (dataBytesLeft > 0) {
            const take = Math.min(dataBytesLeft, buffer.length - offset);
            this.push(buffer.subarray(offset, offset + take));
            offset += take;
            dataBytesLeft -= take;
            continue;
          }
          if (buffer.length - offset < TAR_BLOCK_SIZE_IN_BYTES) {
            break;
          }
          const header = Buffer.from(buffer.subarray(offset, offset + TAR_BLOCK_SIZE_IN_BYTES));
          offset += TAR_BLOCK_SIZE_IN_BYTES;
          dataBytesLeft = normalizeTarHeader(header, headerCount);
          headerCount++;
          this.push(header);
        }
      } catch (error) {
        callback(error as Error);
        return;
      }
      pending = Buffer.from(buffer.subarray(offset));
      callback();
    }
  });
}

/**
 * Gzips a tar archive, rewriting every header checksum on the way so toybox
 * `tar xzf` accepts the result.
 *
 * @param params - The source archive and the target path.
 */
export async function gzipTarForToybox(params: GzipTarForToyboxParams): Promise<void> {
  await pipeline(createReadStream(params.sourcePath), createTarChecksumNormalizer(), createGzip(), createWriteStream(params.targetPath));
}

/**
 * Rewrites one header's checksum in place as seven zero-padded octal digits
 * plus NUL, after checking that the stored checksum matches the header.
 *
 * An all-zero block (the end-of-archive marker and the padding after it) is
 * left as it is.
 *
 * @param header - The 512-byte header, rewritten in place.
 * @param headerIndex - The header's position in the archive, for the error message.
 * @returns How many bytes of data and padding follow the header.
 */
export function normalizeTarHeader(header: Buffer, headerIndex = 0): number {
  if (header.every((byte) => byte === NUL)) {
    return 0;
  }
  const checksum = computeTarHeaderChecksum(header);
  const storedChecksum = parseOctalField(header.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_LENGTH));
  if (storedChecksum !== checksum) {
    throw new Error(
      `tar header ${String(headerIndex)} stores checksum ${String(storedChecksum)} but its bytes sum to ${String(checksum)}, so the archive walk lost its place or the archive is corrupt.`
    );
  }
  header.write(checksum.toString(OCTAL_RADIX).padStart(CHECKSUM_DIGIT_COUNT, '0'), CHECKSUM_OFFSET, 'ascii');
  header[CHECKSUM_OFFSET + CHECKSUM_DIGIT_COUNT] = NUL;
  return Math.ceil(readTarEntrySize(header) / TAR_BLOCK_SIZE_IN_BYTES) * TAR_BLOCK_SIZE_IN_BYTES;
}

/**
 * Reads the size of the data that follows a header, in either the octal form
 * or the base-256 form tar uses for an entry of 8 GiB or more.
 *
 * @param header - The 512-byte header.
 * @returns The size in bytes.
 */
export function readTarEntrySize(header: Buffer): number {
  const field = header.subarray(SIZE_OFFSET, SIZE_OFFSET + SIZE_LENGTH);
  const firstByte = header.readUInt8(SIZE_OFFSET);
  if (firstByte < BASE_256_FLAG) {
    return parseOctalField(field) ?? 0;
  }
  let size = firstByte - BASE_256_FLAG;
  for (const byte of field.subarray(1)) {
    size = size * BYTE_RADIX + byte;
  }
  return size;
}

function parseOctalField(field: Uint8Array): number | undefined {
  let value: number | undefined;
  for (const byte of field) {
    if (byte >= DIGIT_ZERO && byte <= DIGIT_SEVEN) {
      value = (value ?? 0) * OCTAL_RADIX + byte - DIGIT_ZERO;
    } else if (byte !== SPACE || value !== undefined) {
      break;
    }
  }
  return value;
}
