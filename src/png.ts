/**
 * PNG structural validator.
 *
 * The document is parsed through an irreversible sequence of phases:
 *
 *   await-ihdr -> after-ihdr -> after-plte -> in-idat -> after-iend
 *
 * Only the known critical chunks (IHDR, PLTE, IDAT, IEND) may move the
 * parser forward. Ancillary chunks never change the phase: encountering an
 * unknown ancillary chunk therefore cannot "reset" the stream into accepting
 * a second IHDR or more IDAT data after IEND.
 */

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Per PNG 1.2 table 4.1: legal bit depths for each colour type. */
export const ALLOWED_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
	0: [1, 2, 4, 8, 16],
	2: [8, 16],
	3: [1, 2, 4, 8],
	4: [8, 16],
	6: [8, 16],
};

const KNOWN_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

/** Ancillary chunks that may only appear after PLTE. */
const PLTE_GATED_ANCILLARY = new Set(['bKGD', 'hIST']);

export type DocumentPhase =
	| 'await-ihdr'
	| 'after-ihdr'
	| 'after-plte'
	| 'in-idat'
	| 'after-iend';

export interface ChunkFlags {
	/** First type byte, bit 5: lowercase first letter. */
	ancillary: boolean;
	/** Second type byte, bit 5: lowercase second letter. */
	private: boolean;
	/** Third type byte, bit 5: reserved, must be uppercase in PNG 1.2. */
	reserved: boolean;
	/** Fourth type byte, bit 5: lowercase fourth letter. */
	safeToCopy: boolean;
}

export interface SeenChunk {
	type: string;
	data: Uint8Array;
	flags: ChunkFlags;
}

export interface IHDRInfo {
	width: number;
	height: number;
	bitDepth: number;
	colorType: number;
	compressionMethod: number;
	filterMethod: number;
	interlaceMethod: number;
}

export interface PngDocument {
	phase: DocumentPhase;
	ihdr: IHDRInfo;
	plte: Uint8Array | null;
	trns: Uint8Array | null;
	/** Concatenated IDAT payload, in stream order. */
	idat: Uint8Array;
	/** Ancillary chunks accepted before IDAT, in stream order. */
	ancillary: SeenChunk[];
	/** Raw bytes found after IEND; only populated when trailing is allowed. */
	trailing: Uint8Array;
}

export interface PngParserOptions {
	/**
	 * If false (default), any byte after IEND is a structural error.
	 * If true, trailing bytes are kept verbatim on the document and are
	 * never parsed as chunks.
	 */
	allowTrailingAfterIend?: boolean;
}

export interface PngErrorDetails {
	code: string;
	/** Offending chunk type, or null for stream-level errors. */
	chunkType: string | null;
	/** Phase the parser was in when the error was detected. */
	phase: DocumentPhase | 'signature' | null;
	/** What the parser required instead (chunk name or phase description). */
	expected: string;
	safeToCopy?: boolean;
	ancillary?: boolean;
}

export class PngStructureError extends Error implements PngErrorDetails {
	readonly code: string;
	readonly chunkType: string | null;
	readonly phase: DocumentPhase | 'signature' | null;
	readonly expected: string;
	readonly safeToCopy?: boolean;
	readonly ancillary?: boolean;

	constructor(details: PngErrorDetails) {
		const where = details.phase ? ` in phase '${details.phase}'` : '';
		const subject =
			details.chunkType !== null ? `chunk '${details.chunkType}'` : 'stream';
		super(
			`${details.code}: ${subject}${where} is invalid; expected ${details.expected}`,
		);
		this.name = 'PngStructureError';
		this.code = details.code;
		this.chunkType = details.chunkType;
		this.phase = details.phase;
		this.expected = details.expected;
		this.safeToCopy = details.safeToCopy;
		this.ancillary = details.ancillary;
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] * 0x1000000 +
			((bytes[offset + 1] << 16) |
				(bytes[offset + 2] << 8) |
				bytes[offset + 3])) >>>
		0
	);
}

function isTypeLetter(byte: number): boolean {
	return (
		(byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
	);
}

/** Read the four property bits of a chunk type (PNG 1.2 section 5.3). */
export function chunkFlags(type: string): ChunkFlags {
	const codes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
	return {
		ancillary: (codes[0] & 0x20) !== 0,
		private: (codes[1] & 0x20) !== 0,
		reserved: (codes[2] & 0x20) !== 0,
		safeToCopy: (codes[3] & 0x20) !== 0,
	};
}

function parseIHDR(data: Uint8Array): IHDRInfo {
	const info: IHDRInfo = {
		width: readU32(data, 0),
		height: readU32(data, 4),
		bitDepth: data[8],
		colorType: data[9],
		compressionMethod: data[10],
		filterMethod: data[11],
		interlaceMethod: data[12],
	};

	const fail = (why: string): never => {
		throw new PngStructureError({
			code: 'invalid-ihdr',
			chunkType: 'IHDR',
			phase: 'await-ihdr',
			expected: why,
		});
	};

	if (info.width === 0 || info.width > 0x7fffffff) fail('width in [1, 2^31-1]');
	if (info.height === 0 || info.height > 0x7fffffff) fail('height in [1, 2^31-1]');
	const depths = ALLOWED_BIT_DEPTHS[info.colorType];
	if (!depths) fail('color type 0, 2, 3, 4 or 6');
	if (!depths.includes(info.bitDepth)) {
		fail(`bit depth one of ${depths.join('/')} for color type ${info.colorType}`);
	}
	if (info.compressionMethod !== 0) fail('compression method 0');
	if (info.filterMethod !== 0) fail('filter method 0');
	if (info.interlaceMethod !== 0 && info.interlaceMethod !== 1) {
		fail('interlace method 0 or 1');
	}
	return info;
}

/**
 * Streaming PNG parser. Feed arbitrary byte fragments with {@link write};
 * call {@link end} once to finalise and obtain the document summary.
 * Structural problems throw {@link PngStructureError}.
 */
export class PngParser {
	private readonly allowTrailing: boolean;
	private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	private signatureChecked = false;
	private finished = false;

	private phase: DocumentPhase = 'await-ihdr';
	private ihdr: IHDRInfo | null = null;
	private plte: Uint8Array | null = null;
	private trns: Uint8Array | null = null;
	private readonly idatParts: Uint8Array[] = [];
	private readonly ancillaryChunks: SeenChunk[] = [];
	private readonly trailingParts: Uint8Array[] = [];
	private trailingLength = 0;

	constructor(options: PngParserOptions = {}) {
		this.allowTrailing = options.allowTrailingAfterIend ?? false;
	}

	/** Feed a fragment. Partial chunks are buffered until complete. */
	write(input: Uint8Array): void {
		if (this.finished) {
			throw new PngStructureError({
				code: 'write-after-end',
				chunkType: null,
				phase: this.phase,
				expected: 'no further input',
			});
		}
		this.buffer = this.buffer.length === 0 ? input : concat([this.buffer, input]);
		this.drain();
	}

	/** Mark the stream complete and validate the final phase. */
	end(input?: Uint8Array): PngDocument {
		if (input) this.write(input);

		if (this.phase !== 'after-iend') {
			if (!this.signatureChecked) {
				throw new PngStructureError({
					code: 'truncated-signature',
					chunkType: null,
					phase: null,
					expected: 'the 8-byte PNG signature',
				});
			}
			if (this.buffer.length > 0) {
				throw new PngStructureError({
					code: 'truncated-chunk',
					chunkType: null,
					phase: this.phase,
					expected: 'a complete chunk (length, type, data and CRC)',
				});
			}
			if (this.phase === 'await-ihdr') {
				throw new PngStructureError({
					code: 'missing-ihdr',
					chunkType: null,
					phase: this.phase,
					expected: 'IHDR as the first chunk',
				});
			}
			if (this.phase === 'in-idat') {
				throw new PngStructureError({
					code: 'missing-iend',
					chunkType: null,
					phase: this.phase,
					expected: 'IEND to terminate the IDAT sequence',
				});
			}
			throw new PngStructureError({
				code: 'missing-idat',
				chunkType: null,
				phase: this.phase,
				expected: 'at least one IDAT chunk followed by IEND',
			});
		}

		this.finished = true;
		return {
			phase: this.phase,
			ihdr: this.ihdr as IHDRInfo,
			plte: this.plte,
			trns: this.trns,
			idat: concat(this.idatParts),
			ancillary: this.ancillaryChunks,
			trailing: concat(this.trailingParts),
		};
	}

	private drain(): void {
		if (!this.signatureChecked) {
			if (this.buffer.length < SIGNATURE.length) return;
			for (let i = 0; i < SIGNATURE.length; i++) {
				if (this.buffer[i] !== SIGNATURE[i]) {
					throw new PngStructureError({
						code: 'invalid-signature',
						chunkType: null,
						phase: 'signature',
						expected: 'the PNG signature 89 50 4E 47 0D 0A 1A 0A',
					});
				}
			}
			this.signatureChecked = true;
			this.buffer = this.buffer.slice(SIGNATURE.length);
		}

		for (;;) {
			// After IEND, remaining bytes are trailing data, never chunks.
			if (this.phase === 'after-iend') {
				if (this.buffer.length > 0) this.consumeTrailing(this.buffer);
				this.buffer = new Uint8Array(0);
				return;
			}

			if (this.buffer.length < 8) return; // need length + type
			const length = readU32(this.buffer, 0);
			const frameSize = 12 + length; // length(4) + type(4) + data + CRC(4)
			if (this.buffer.length < frameSize) return; // wait for data + CRC

			const typeBytes = this.buffer.slice(4, 8);
			for (const byte of typeBytes) {
				if (!isTypeLetter(byte)) {
					throw new PngStructureError({
						code: 'invalid-chunk-type',
						chunkType: null,
						phase: this.phase,
						expected: 'a 4-letter ASCII chunk type',
					});
				}
			}
			const type = String.fromCharCode(...typeBytes);
			const data = this.buffer.slice(8, 8 + length);
			this.buffer = this.buffer.slice(frameSize);
			this.handleChunk({ type, data, flags: chunkFlags(type) });
		}
	}

	private consumeTrailing(bytes: Uint8Array): void {
		this.trailingLength += bytes.length;
		if (!this.allowTrailing) {
			throw new PngStructureError({
				code: 'trailing-data',
				chunkType: null,
				phase: 'after-iend',
				expected: 'end of stream (IEND must be last; enable allowTrailingAfterIend to keep bytes)',
			});
		}
		this.trailingParts.push(bytes);
	}

	private error(
		code: string,
		chunk: SeenChunk,
		expected: string,
	): PngStructureError {
		return new PngStructureError({
			code,
			chunkType: chunk.type,
			phase: this.phase,
			expected,
			ancillary: chunk.flags.ancillary,
			safeToCopy: chunk.flags.safeToCopy,
		});
	}

	private handleChunk(chunk: SeenChunk): void {
		const { type, data, flags } = chunk;

		// Any unknown critical chunk is fatal, wherever it appears. The
		// safe-to-copy / ancillary property bits are reported with it.
		if (!flags.ancillary && !KNOWN_CRITICAL.has(type)) {
			throw this.error(
				'unknown-critical',
				chunk,
				'IHDR, PLTE, IDAT or IEND (unknown critical chunks are unsupported)',
			);
		}

		switch (this.phase) {
			case 'await-ihdr':
				// IHDR must be first; nothing else is legal here.
				if (type === 'IHDR') {
					if (data.length !== 13) {
						throw this.error('invalid-ihdr', chunk, 'IHDR data of 13 bytes');
					}
					this.ihdr = parseIHDR(data);
					this.phase = 'after-ihdr';
					return;
				}
				throw this.error('ihdr-first', chunk, 'IHDR as the first chunk');

			case 'after-ihdr':
			case 'after-plte':
				this.handlePreIdat(chunk);
				return;

			case 'in-idat':
				if (type === 'IDAT') {
					this.idatParts.push(data);
					return;
				}
				if (type === 'IEND') {
					this.handleIend(chunk);
					return;
				}
				// IDAT chunks must be consecutive; anything between the
				// first IDAT and IEND (ancillary included) is an error and
				// does not move the parser out of the idat phase.
				throw this.error(
					'idat-interrupted',
					chunk,
					'IDAT (chunks must be consecutive) or IEND',
				);

			case 'after-iend':
				// Handled in drain(): bytes after IEND are never parsed.
				return;
		}
	}

	private handlePreIdat(chunk: SeenChunk): void {
		const { type, data } = chunk;
		const ihdr = this.ihdr as IHDRInfo;

		switch (type) {
			case 'IHDR':
				throw this.error('duplicate-ihdr', chunk, 'at most one IHDR chunk');

			case 'IEND':
				throw this.error(
					'missing-idat',
					chunk,
					'at least one IDAT chunk before IEND',
				);

			case 'PLTE':
				if (this.phase === 'after-plte') {
					throw this.error('duplicate-plte', chunk, 'at most one PLTE chunk');
				}
				if (ihdr.colorType === 0 || ihdr.colorType === 4) {
					throw this.error(
						'palette-forbidden',
						chunk,
						`no PLTE for color type ${ihdr.colorType} (greyscale)`,
					);
				}
				if (data.length === 0 || data.length % 3 !== 0) {
					throw this.error(
						'invalid-plte',
						chunk,
						'a PLTE length that is a positive multiple of 3',
					);
				}
				if (data.length / 3 > 256) {
					throw this.error('invalid-plte', chunk, 'at most 256 palette entries');
				}
				this.plte = data;
				this.phase = 'after-plte';
				return;

			case 'IDAT':
				if (ihdr.colorType === 3 && this.plte === null) {
					throw this.error(
						'palette-required',
						chunk,
						'PLTE before IDAT for color type 3',
					);
				}
				this.idatParts.push(data);
				this.phase = 'in-idat';
				return;

			default:
				this.handleAncillary(chunk);
		}
	}

	private handleAncillary(chunk: SeenChunk): void {
		const { type, data } = chunk;
		const ihdr = this.ihdr as IHDRInfo;

		if (!chunk.flags.ancillary) {
			// Known critical types are handled above; anything else was
			// rejected as unknown-critical before reaching this point.
			throw this.error('unknown-critical', chunk, 'an ancillary chunk');
		}

		switch (type) {
			case 'tRNS':
				if (this.trns !== null) {
					throw this.error('duplicate-trns', chunk, 'at most one tRNS chunk');
				}
				if (ihdr.colorType === 4 || ihdr.colorType === 6) {
					throw this.error(
						'trns-forbidden',
						chunk,
						`no tRNS for color type ${ihdr.colorType} (alpha channel present)`,
					);
				}
				if (ihdr.colorType === 3) {
					if (this.plte === null) {
						throw this.error(
							'trns-after-plte',
							chunk,
							'tRNS to follow PLTE for indexed color type 3',
						);
					}
					if (data.length > this.plte.length / 3) {
						throw this.error(
							'invalid-trns',
							chunk,
							'a tRNS palette index list no longer than the PLTE entry count',
						);
					}
				} else if (ihdr.colorType === 0) {
					if (data.length !== 2) {
						throw this.error('invalid-trns', chunk, 'tRNS data of 2 bytes for color type 0');
					}
				} else if (ihdr.colorType === 2) {
					if (data.length !== 6) {
						throw this.error('invalid-trns', chunk, 'tRNS data of 6 bytes for color type 2');
					}
				}
				this.trns = data;
				this.ancillaryChunks.push(chunk);
				// Ancillary chunks never change the document phase.
				return;

			case 'bKGD':
			case 'hIST':
				if (this.plte === null) {
					throw this.error(
						'ancillary-after-plte',
						chunk,
						`${type} to follow PLTE`,
					);
				}
				this.ancillaryChunks.push(chunk);
				return;

			default:
				// Unknown (or otherwise unmodelled) ancillary chunk: accept
				// it, preserve the property bits, and keep the phase.
				this.ancillaryChunks.push(chunk);
				return;
		}
	}

	private handleIend(chunk: SeenChunk): void {
		if (chunk.data.length !== 0) {
			throw this.error('invalid-iend', chunk, 'an empty IEND data field');
		}
		this.phase = 'after-iend';
	}
}

/** Parse a complete PNG byte sequence in one call. */
export function parsePng(
	data: Uint8Array,
	options?: PngParserOptions,
): PngDocument {
	const parser = new PngParser(options);
	parser.write(data);
	return parser.end();
}
