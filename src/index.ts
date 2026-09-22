export interface ChunkTypeFlags {
  /** Byte 0 is lowercase: ancillary instead of critical. */
  ancillary: boolean;
  /** Byte 1 is lowercase: privately reserved chunk. */
  privateChunk: boolean;
  /** Byte 2 is lowercase: reserved bit is set. */
  reservedBit: boolean;
  /** Byte 3 is lowercase: the chunk is safe to copy. */
  safeToCopy: boolean;
}

export interface Chunk {
  type: string;
  data: Uint8Array;
  crc: number;
  offset: number;
  flags: ChunkTypeFlags;
}

export interface ImageHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compressionMethod: number;
  filterMethod: number;
  interlaceMethod: number;
}

export interface ParsePngOptions {
  /** Allow unparsed bytes after IEND. Defaults to false. */
  allowTrailingBytes?: boolean;
}

export interface ParsedPng {
  ihdr: ImageHeader;
  palette: Uint8Array | null;
  idatData: Uint8Array;
  chunks: Chunk[];
  trailingBytes?: Uint8Array;
}

export type PngParseStage =
  | 'before-ihdr'
  | 'after-ihdr'
  | 'after-plte'
  | 'idat'
  | 'after-iend';

export type PngParseErrorCode =
  | 'invalidSignature'
  | 'truncatedChunk'
  | 'invalidChunkType'
  | 'invalidChunkOrder'
  | 'unknownCriticalChunk'
  | 'duplicateIhdr'
  | 'duplicatePlte'
  | 'invalidIhdr'
  | 'invalidColorType'
  | 'invalidPlte'
  | 'paletteRequired'
  | 'paletteNotAllowed'
  | 'nonConsecutiveIdat'
  | 'missingIdat'
  | 'invalidIend'
  | 'missingIend'
  | 'trailingBytes';

export interface PngParseErrorDetails {
  code: PngParseErrorCode;
  chunk: Chunk | null;
  currentStage: PngParseStage;
  requiredStage: string;
}

export class PngParseError extends Error implements PngParseErrorDetails {
  readonly code: PngParseErrorCode;
  readonly chunk: Chunk | null;
  readonly currentStage: PngParseStage;
  readonly requiredStage: string;

  constructor(message: string, details: PngParseErrorDetails) {
    super(message);
    this.name = 'PngParseError';
    this.code = details.code;
    this.chunk = details.chunk;
    this.currentStage = details.currentStage;
    this.requiredStage = details.requiredStage;
  }

  get chunkType(): string | null {
    return this.chunk?.type ?? null;
  }
}

const PNG_SIGNITURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const KNOWN_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const ALLOWED_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function readChunk(input: Uint8Array, offset = 0): Chunk | null {
  if (offset < 0 || offset > input.length || input.length - offset < 12) {
    return null;
  }

  const length = readUint32(input, offset);
  const chunkEnd = offset + 12 + length;
  if (chunkEnd > input.length) {
    return null;
  }

  const typeBytes = input.subarray(offset + 4, offset + 8);
  const type = new TextDecoder().decode(typeBytes);

  return {
    type,
    data: input.subarray(offset + 8, offset + 8 + length),
    crc: readUint32(input, offset + 8 + length),
    offset,
    flags: {
      ancillary: isLowerAscii(typeBytes[0]),
      privateChunk: isLowerAscii(typeBytes[1]),
      reservedBit: isLowerAscii(typeBytes[2]),
      safeToCopy: isLowerAscii(typeBytes[3]),
    },
  };
}

export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function parsePng(input: Uint8Array, options: ParsePngOptions = {}): ParsedPng {
  if (input.length < PNG_SIGNITURE.length || !hasSignature(input)) {
    throw parseError('Input does not begin with the PNG signature', {
      code: 'invalidSignature',
      chunk: null,
      currentStage: 'before-ihdr',
      requiredStage: 'IHDR',
    });
  }

  let offset = PNG_SIGNITURE.length;
  let stage: PngParseStage = 'before-ihdr';
  let ihdr: ImageHeader | null = null;
  let palette: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  const chunks: Chunk[] = [];

  let idatStarted = false;
  let idatFinished = false;
  let iendSeen = false;

  while (offset < input.length) {
    const chunk = readChunk(input, offset);
    if (chunk === null) {
      throw parseError('Truncated PNG chunk', {
        code: 'truncatedChunk',
        chunk: null,
        currentStage: stage,
        requiredStage: iendSeen ? 'END' : 'IEND',
      });
    }
    offset = chunk.offset + 12 + chunk.data.length;

    if (!isValidChunkType(chunk)) {
      throw parseError(`Invalid chunk type "${chunk.type}"`, {
        code: 'invalidChunkType',
        chunk,
        currentStage: stage,
        requiredStage: requiredCriticalStage(stage, ihdr, palette, idatFinished),
      });
    }

    if (!chunk.flags.ancillary && !KNOWN_CRITICAL_CHUNKS.has(chunk.type)) {
      throw parseError(`Unknown critical chunk "${chunk.type}"`, {
        code: 'unknownCriticalChunk',
        chunk,
        currentStage: stage,
        requiredStage: requiredCriticalStage(stage, ihdr, palette, idatFinished),
      });
    }

    if (stage === 'before-ihdr' && chunk.type !== 'IHDR') {
      throw orderError(chunk, stage, 'IHDR', 'IHDR must be the first chunk');
    }

    if (chunk.flags.ancillary) {
      chunks.push(chunk);
      // Ancillary chunks never move a critical-chunk milestone backwards or
      // forwards. One after IDAT does, however, end the consecutive IDAT run.
      if (stage === 'idat') {
        idatFinished = true;
      }
      continue;
    }

    switch (chunk.type) {
      case 'IHDR': {
        if (stage !== 'before-ihdr') {
          throw parseError('IHDR may appear exactly once and must be first', {
            code: 'duplicateIhdr',
            chunk,
            currentStage: stage,
            requiredStage: requiredCriticalStage(stage, ihdr, palette, idatFinished),
          });
        }

        ihdr = parseImageHeader(chunk, stage);
        chunks.push(chunk);
        stage = 'after-ihdr';
        break;
      }

      case 'PLTE': {
        if (stage === 'idat') {
          throw orderError(
            chunk,
            stage,
            idatFinished ? 'IEND' : 'IDAT or IEND',
            'PLTE must appear before IDAT',
          );
        }

        if (palette !== null) {
          throw parseError('PLTE may appear at most once', {
            code: 'duplicatePlte',
            chunk,
            currentStage: stage,
            requiredStage: 'IDAT',
          });
        }

        if (ihdr?.colorType === 0 || ihdr?.colorType === 4) {
          throw parseError(`PLTE is not allowed for color type ${ihdr.colorType}`, {
            code: 'paletteNotAllowed',
            chunk,
            currentStage: stage,
            requiredStage: 'IDAT',
          });
        }

        if (chunk.data.length < 3 || chunk.data.length > 768 || chunk.data.length % 3 !== 0) {
          throw parseError('PLTE must contain between 1 and 256 RGB entries', {
            code: 'invalidPlte',
            chunk,
            currentStage: stage,
            requiredStage: 'IDAT',
          });
        }

        palette = chunk.data.slice();
        chunks.push(chunk);
        stage = 'after-plte';
        break;
      }

      case 'IDAT': {
        if (stage !== 'after-ihdr' && stage !== 'after-plte' && stage !== 'idat') {
          throw orderError(chunk, stage, 'IHDR', 'IDAT requires an earlier IHDR');
        }

        if (ihdr.colorType === 3 && palette === null) {
          throw parseError('PLTE is required before IDAT for color type 3', {
            code: 'paletteRequired',
            chunk,
            currentStage: stage,
            requiredStage: 'PLTE',
          });
        }

        if (idatStarted && idatFinished) {
          throw parseError('IDAT chunks must be consecutive', {
            code: 'nonConsecutiveIdat',
            chunk,
            currentStage: stage,
            requiredStage: 'IEND',
          });
        }

        idatStarted = true;
        stage = 'idat';
        idatParts.push(chunk.data.slice());
        chunks.push(chunk);
        break;
      }

      case 'IEND': {
        if (stage !== 'idat') {
          throw orderError(chunk, stage, 'IDAT', 'IEND requires at least one earlier IDAT');
        }

        if (chunk.data.length !== 0) {
          throw parseError('IEND must have zero length', {
            code: 'invalidIend',
            chunk,
            currentStage: stage,
            requiredStage: 'IEND',
          });
        }

        iendSeen = true;
        chunks.push(chunk);
        stage = 'after-iend';
        break;
      }
    }

    if (iendSeen) {
      break;
    }
  }

  if (!iendSeen) {
    if (!idatStarted) {
      throw parseError('PNG stream must contain at least one IDAT chunk', {
        code: 'missingIdat',
        chunk: null,
        currentStage: stage,
        requiredStage: 'IDAT',
      });
    }

    throw parseError('PNG stream must end with IEND', {
      code: 'missingIend',
      chunk: null,
      currentStage: stage,
      requiredStage: 'IEND',
    });
  }

  const trailingBytes = input.subarray(offset);
  if (trailingBytes.length > 0 && !options.allowTrailingBytes) {
    const iend = chunks[chunks.length - 1] ?? null;
    throw parseError('Unexpected bytes after IEND', {
      code: 'trailingBytes',
      chunk: iend,
      currentStage: 'after-iend',
      requiredStage: 'END',
    });
  }

  return {
    ihdr: ihdr as ImageHeader,
    palette,
    idatData: concatenate(idatParts),
    chunks,
    ...(trailingBytes.length > 0 ? { trailingBytes: trailingBytes.slice() } : {}),
  };
}

function parseImageHeader(chunk: Chunk, currentStage: PngParseStage): ImageHeader {
  if (chunk.data.length !== 13) {
    throw parseError('IHDR must be exactly 13 bytes', {
      code: 'invalidIhdr',
      chunk,
      currentStage,
      requiredStage: 'IHDR',
    });
  }

  const data = chunk.data;
  const header: ImageHeader = {
    width: readUint32(data, 0),
    height: readUint32(data, 4),
    bitDepth: data[8],
    colorType: data[9],
    compressionMethod: data[10],
    filterMethod: data[11],
    interlaceMethod: data[12],
  };

  if (header.width === 0 || header.width > 0x7fffffff || header.height === 0 || header.height > 0x7fffffff) {
    throw parseError('IHDR contains invalid image dimensions', {
      code: 'invalidIhdr',
      chunk,
      currentStage,
      requiredStage: 'IHDR',
    });
  }

  if (!(header.colorType in ALLOWED_BIT_DEPTHS)) {
    throw parseError(`Unsupported PNG color type ${header.colorType}`, {
      code: 'invalidColorType',
      chunk,
      currentStage,
      requiredStage: 'IHDR',
    });
  }

  if (!ALLOWED_BIT_DEPTHS[header.colorType].includes(header.bitDepth)) {
    throw parseError(
      `Bit depth ${header.bitDepth} is not allowed for color type ${header.colorType}`,
      {
        code: 'invalidColorType',
        chunk,
        currentStage,
        requiredStage: 'IHDR',
      },
    );
  }

  if (header.compressionMethod !== 0 || header.filterMethod !== 0 || header.interlaceMethod > 1) {
    throw parseError('IHDR contains an unsupported method value', {
      code: 'invalidIhdr',
      chunk,
      currentStage,
      requiredStage: 'IHDR',
    });
  }

  return header;
}

function requiredCriticalStage(
  stage: PngParseStage,
  ihdr: ImageHeader | null,
  palette: Uint8Array | null,
  idatFinished: boolean,
): string {
  switch (stage) {
    case 'before-ihdr':
      return 'IHDR';
    case 'after-ihdr':
      return ihdr?.colorType === 3 && palette === null ? 'PLTE or IDAT' : 'IDAT';
    case 'after-plte':
      return 'IDAT';
    case 'idat':
      return idatFinished ? 'IEND' : 'IDAT or IEND';
    case 'after-iend':
      return 'END';
  }
}

function orderError(
  chunk: Chunk,
  currentStage: PngParseStage,
  requiredStage: string,
  message: string,
): never {
  throw parseError(`${message}; found "${chunk.type}"`, {
    code: 'invalidChunkOrder',
    chunk,
    currentStage,
    requiredStage,
  });
}

function parseError(message: string, details: PngParseErrorDetails): PngParseError {
  return new PngParseError(message, details);
}

function hasSignature(input: Uint8Array): boolean {
  return PNG_SIGNITIRY.every((value, index) => input[index] === value);
}

function isValidChunkType(chunk: Chunk): boolean {
  const bytes = new TextEncoder().encode(chunk.type);
  return bytes.length === 4 && bytes.every(isAsciiLetter);
}

function isAsciiLetter(value: number): boolean {
  return isUpperAscii(value) || isLowerAscii(value);
}

function isUpperAscii(value: number): boolean {
  return value >= 65 && value <= 90;
}

function isLowerAscii(value: number): boolean {
  return value >= 97 && value <= 122;
}

function readUint32(input: Uint8Array, offset: number): number {
  return (
    input[offset] * 0x1000000 +
    input[offset + 1] * 0x10000 +
    input[offset + 2] * 0x100 +
    input[offset + 3]
  ) >>> 0;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}
