import { describe, expect, it } from 'vitest';
import {
	PngParser,
	PngStructureError,
	chunkFlags,
	parsePng,
} from '../src/index.js';

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function u32(n: number): number[] {
	return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: number[] | Uint8Array = []): Uint8Array {
	const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
	const out = new Uint8Array(12 + d.length);
	out.set(u32(d.length), 0);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(d, 8);
	return out; // CRC field intentionally zero; validator does not check CRC
}

function ihdr(
	opts: {
		width?: number;
		height?: number;
		bitDepth?: number;
		colorType?: number;
		interlace?: number;
	} = {},
): Uint8Array {
	const w = opts.width ?? 1;
	const h = opts.height ?? 1;
	const bd = opts.bitDepth ?? 8;
	const ct = opts.colorType ?? 0;
	return chunk('IHDR', [
		...u32(w),
		...u32(h),
		bd,
		ct,
		0, // compression
		0, // filter
		opts.interlace ?? 0,
	]);
}

function build(...chunks: Uint8Array[]): Uint8Array {
	let total = SIG.length;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	out.set(SIG, 0);
	let off = SIG.length;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

/** Feed a document one byte at a time to exercise chunk reassembly. */
function feedByteByByte(bytes: Uint8Array, options?): ReturnType<PngParser['end']> {
	const parser = new PngParser(options);
	for (const b of bytes) parser.write(Uint8Array.from([b]));
	return parser.end();
}

function expectError(
	fn: () => unknown,
	fields: Partial<PngStructureError> & { code: string },
): PngStructureError {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(PngStructureError);
		const err = e as PngStructureError;
		for (const [key, value] of Object.entries(fields)) {
			expect(err[key as keyof PngStructureError], `error.${key}`).toEqual(value);
		}
		return err;
	}
	throw new Error(`expected error code ${fields.code}`);
}

describe('valid documents', () => {
	it('accepts a minimal greyscale image with unknown ancillary chunks', () => {
		const doc = parsePng(
			build(
				ihdr({ colorType: 0, bitDepth: 8 }),
				chunk('xTXT', [1, 2, 3]), // unknown ancillary, safe-to-copy = false
				chunk('xTXt', [9]), // unknown ancillary, safe-to-copy = true
				chunk('IDAT', [0xde, 0xad]),
				chunk('IDAT', [0xbe, 0xef]),
				chunk('IEND'),
			),
		);
		expect(doc.phase).toBe('after-iend');
		expect(doc.idat).toEqual(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
		expect(doc.ancillary.map((c) => c.type)).toEqual(['xTXT', 'xTXt']);
		expect(doc.ancillary[0].flags).toEqual({
			ancillary: true,
			private: false,
			reserved: false,
			safeToCopy: false,
		});
		expect(doc.ancillary[1].flags.safeToCopy).toBe(true);
		expect(doc.trailing.length).toBe(0);
	});

	it('reassembles chunks scattered across one-byte writes', () => {
		const bytes = build(
			ihdr({ colorType: 2, bitDepth: 16 }),
			chunk('tEXt', [0]),
			chunk('IDAT', [1]),
			chunk('IDAT', [2, 3]),
			chunk('IEND'),
		);
		const doc = feedByteByByte(bytes);
		expect(doc.idat).toEqual(Uint8Array.from([1, 2, 3]));
		expect(doc.ihdr.colorType).toBe(2);
		expect(doc.ihdr.bitDepth).toBe(16);
	});

	it('accepts indexed color with PLTE and tRNS', () => {
		const doc = parsePng(
			build(
				ihdr({ colorType: 3, bitDepth: 4 }),
				chunk('PLTE', [0, 0, 0, 255, 255, 255, 10, 20, 30]),
				chunk('tRNS', [128, 255]),
				chunk('bKGD', [0, 1]),
				chunk('IDAT', [7]),
				chunk('IEND'),
			),
		);
		expect(doc.plte).toEqual(Uint8Array.from([0, 0, 0, 255, 255, 255, 10, 20, 30]));
		expect(doc.trns).toEqual(Uint8Array.from([128, 255]));
	});

	it('accepts color type 6 without PLTE', () => {
		const doc = parsePng(
			build(ihdr({ colorType: 6, bitDepth: 8 }), chunk('IDAT'), chunk('IEND')),
		);
		expect(doc.plte).toBeNull();
	});
});

describe('IHDR presence and ordering', () => {
	it('reports missing IHDR when the stream only holds the signature', () => {
		expectError(() => parsePng(SIG), {
			code: 'missing-ihdr',
			chunkType: null,
			phase: 'await-ihdr',
			expected: 'IHDR as the first chunk',
		});
	});

	it('reports an empty/truncated stream', () => {
		expectError(() => parsePng(new Uint8Array(0)), {
			code: 'truncated-signature',
			phase: null,
		});
		expectError(() => parsePng(SIG.slice(0, 4)), {
			code: 'truncated-signature',
		});
	});

	it('rejects any chunk before IHDR and reports the current chunk + needed phase', () => {
		expectError(
			() => parsePng(build(chunk('PLTE', [0, 0, 0]), chunk('IEND'))),
			{
				code: 'ihdr-first',
				chunkType: 'PLTE',
				phase: 'await-ihdr',
				expected: 'IHDR as the first chunk',
			},
		);
		// Even safe-to-copy unknown ancillary chunks cannot precede IHDR.
		expectError(() => parsePng(build(chunk('xTXt'))), {
			code: 'ihdr-first',
			chunkType: 'xTXt',
			phase: 'await-ihdr',
			ancillary: true,
			safeToCopy: true,
		});
	});

	it('rejects a second IHDR and keeps phase after-ihdr (no reset)', () => {
		expectError(
			() =>
				parsePng(
					build(ihdr(), chunk('xTXt'), ihdr(), chunk('IDAT'), chunk('IEND')),
				),
			{
				code: 'duplicate-ihdr',
				chunkType: 'IHDR',
				phase: 'after-ihdr',
			},
		);
	});

	it('rejects an IHDR with wrong data length', () => {
		expectError(() => parsePng(build(chunk('IHDR', [0, 0]))), {
			code: 'invalid-ihdr',
			chunkType: 'IHDR',
			phase: 'await-ihdr',
		});
	});

	it('rejects a bad PNG signature', () => {
		const bad = build(ihdr(), chunk('IEND'));
		bad[0] = 0;
		expectError(() => parsePng(bad), { code: 'invalid-signature', phase: 'signature' });
	});
});

describe('phase machine does not reset on unknown ancillary chunks', () => {
	it('stays in in-idat when an ancillary interrupts IDAT', () => {
		const parser = new PngParser();
		parser.write(build(ihdr(), chunk('IDAT', [1])));
		// An unknown ancillary chunk interrupts the IDAT sequence.
		const first = expectError(() => parser.write(chunk('xTXt', [0])), {
			code: 'idat-interrupted',
			chunkType: 'xTXt',
			phase: 'in-idat',
			expected: 'IDAT (chunks must be consecutive) or IEND',
			ancillary: true,
			safeToCopy: true,
		});
		expect(first.message).toContain("chunk 'xTXt'");
		expect(first.message).toContain("phase 'in-idat'");
		// Phase was NOT reset: a second IHDR is not accepted as a new header.
		expectError(() => parser.write(ihdr()), {
			code: 'idat-interrupted',
			chunkType: 'IHDR',
			phase: 'in-idat',
		});
	});

	it('treats a known ancillary chunk between IDATs as an interruption', () => {
		expectError(
			() =>
				parsePng(
					build(
						ihdr(),
						chunk('IDAT', [1]),
						chunk('tEXt', [0]),
						chunk('IDAT', [2]),
						chunk('IEND'),
					),
				),
			{ code: 'idat-interrupted', chunkType: 'tEXt', phase: 'in-idat' },
		);
	});

	it('keeps phase after-ihdr across unknown ancillary chunks', () => {
		// PLTE arrives after two unknown ancillary chunks: phase must still
		// be after-ihdr, so PLTE is accepted.
		const doc = parsePng(
			build(
				ihdr({ colorType: 3 }),
				chunk('xTXT'),
				chunk('blAH', [5, 6]),
				chunk('PLTE', [1, 2, 3]),
				chunk('IDAT'),
				chunk('IEND'),
			),
		);
		expect(doc.phase).toBe('after-iend');
		expect(doc.ancillary.map((c) => c.type)).toEqual(['xTXT', 'blAH']);
	});
});

describe('PLTE rules', () => {
	it('rejects a duplicate PLTE', () => {
		expectError(
			() =>
				parsePng(
					build(
						ihdr({ colorType: 3 }),
						chunk('PLTE', [0, 0, 0]),
						chunk('PLTE', [1, 1, 1]),
						chunk('IEND'),
					),
				),
			{ code: 'duplicate-plte', chunkType: 'PLTE', phase: 'after-plte' },
		);
	});

	it('forbids PLTE for greyscale color types 0 and 4', () => {
		expectError(
			() => parsePng(build(ihdr({ colorType: 0 }), chunk('PLTE', [0, 0, 0]))),
			{ code: 'palette-forbidden', chunkType: 'PLTE', phase: 'after-ihdr' },
		);
		expectError(
			() => parsePng(build(ihdr({ colorType: 4 }), chunk('PLTE', [0, 0, 0]))),
			{ code: 'palette-forbidden', chunkType: 'PLTE' },
		);
	});

	it('validates PLTE length', () => {
		const base = (plte: Uint8Array) =>
			parsePng(build(ihdr({ colorType: 3 }), plte, chunk('IEND')));
		expectError(() => base(chunk('PLTE', [])), {
			code: 'invalid-plte',
			chunkType: 'PLTE',
		});
		expectError(() => base(chunk('PLTE', [0, 0])), {
			code: 'invalid-plte',
			chunkType: 'PLTE',
		});
		const tooMany = new Uint8Array(257 * 3);
		expectError(() => base(chunk('PLTE', tooMany)), {
			code: 'invalid-plte',
			chunkType: 'PLTE',
		});
	});

	it('requires PLTE before IDAT for color type 3', () => {
		expectError(
			() => parsePng(build(ihdr({ colorType: 3 }), chunk('IDAT'), chunk('IEND'))),
			{ code: 'palette-required', chunkType: 'IDAT', phase: 'after-ihdr' },
		);
	});
});

describe('color type / IHDR constraints', () => {
	it('rejects unknown color types', () => {
		expectError(() => parsePng(build(ihdr({ colorType: 5 }), chunk('IEND'))), {
			code: 'invalid-ihdr',
			chunkType: 'IHDR',
			phase: 'await-ihdr',
		});
	});

	it('rejects bit depth / color type combinations', () => {
		expectError(
			() => parsePng(build(ihdr({ colorType: 2, bitDepth: 1 }), chunk('IEND'))),
			{ code: 'invalid-ihdr', chunkType: 'IHDR' },
		);
		expectError(
			() => parsePng(build(ihdr({ colorType: 3, bitDepth: 16 }), chunk('IEND'))),
			{ code: 'invalid-ihdr', chunkType: 'IHDR' },
		);
		expectError(
			() => parsePng(build(ihdr({ colorType: 0, bitDepth: 3 }), chunk('IEND'))),
			{ code: 'invalid-ihdr', chunkType: 'IHDR' },
		);
	});

	it('rejects zero dimensions and unknown methods', () => {
		expectError(() => parsePng(build(ihdr({ width: 0 }))), {
			code: 'invalid-ihdr',
		});
		expectError(() => parsePng(build(ihdr({ height: 0 }))), {
			code: 'invalid-ihdr',
		});
		const badMethods = chunk('IHDR', [...u32(1), ...u32(1), 8, 0, 1, 0, 0]);
		expectError(() => parsePng(build(badMethods)), { code: 'invalid-ihdr' });
		const badInterlace = chunk('IHDR', [...u32(1), ...u32(1), 8, 0, 0, 0, 2]);
		expectError(() => parsePng(build(badInterlace)), { code: 'invalid-ihdr' });
	});

	it('exposes the allowed bit depth table', async () => {
		const mod = await import('../src/index.js');
		expect(mod.ALLOWED_BIT_DEPTHS[6]).toEqual([8, 16]);
	});
});

describe('tRNS color-type constraints', () => {
	it('forbids tRNS for color types with an alpha channel', () => {
		expectError(
			() =>
				parsePng(build(ihdr({ colorType: 6 }), chunk('tRNS', [0, 0]))),
			{ code: 'trns-forbidden', chunkType: 'tRNS', phase: 'after-ihdr' },
		);
		expectError(
			() =>
				parsePng(build(ihdr({ colorType: 4 }), chunk('tRNS', [0, 0]))),
			{ code: 'trns-forbidden', chunkType: 'tRNS' },
		);
	});

	it('requires tRNS to follow PLTE for indexed images and fit its length', () => {
		expectError(
			() =>
				parsePng(
					build(
						ihdr({ colorType: 3 }),
						chunk('tRNS', [0]),
						chunk('PLTE', [0, 0, 0]),
						chunk('IEND'),
					),
				),
			{ code: 'trns-after-plte', chunkType: 'tRNS', phase: 'after-ihdr' },
		);
		expectError(
			() =>
				parsePng(
					build(
						ihdr({ colorType: 3 }),
						chunk('PLTE', [0, 0, 0]),
						chunk('tRNS', [0, 0]),
						chunk('IEND'),
					),
				),
			{ code: 'invalid-trns', chunkType: 'tRNS' },
		);
	});

	it('validates fixed tRNS sizes for greyscale and truecolor', () => {
		expectError(
			() => parsePng(build(ihdr({ colorType: 0 }), chunk('tRNS', [0]))),
			{ code: 'invalid-trns', chunkType: 'tRNS' },
		);
		expectError(
			() =>
				parsePng(
					build(ihdr({ colorType: 2 }), chunk('tRNS', [0, 0, 0])),
				),
			{ code: 'invalid-trns', chunkType: 'tRNS' },
		);
	});

	it('rejects duplicate tRNS', () => {
		expectError(
			() =>
				parsePng(
					build(
						ihdr({ colorType: 0 }),
						chunk('tRNS', [0, 0]),
						chunk('tRNS', [0, 0]),
						chunk('IEND'),
					),
				),
			{ code: 'duplicate-trns', chunkType: 'tRNS', phase: 'after-ihdr' },
		);
	});

	it('requires bKGD/hIST to follow PLTE', () => {
		expectError(
			() => parsePng(build(ihdr({ colorType: 3 }), chunk('bKGD', [0, 1]))),
			{ code: 'ancillary-after-plte', chunkType: 'bKGD' },
		);
		expectError(
			() => parsePng(build(ihdr({ colorType: 3 }), chunk('hIST', [0, 0]))),
			{ code: 'ancillary-after-plte', chunkType: 'hIST' },
		);
	});
});

describe('unknown critical chunks', () => {
	it('fails fatally and preserves the safe-to-copy bit', () => {
		// 'TESt': critical (T), not private (E), reserved clear (S), safe (t).
		const err = expectError(
			() =>
				parsePng(build(ihdr(), chunk('TESt', [1, 2, 3, 4]), chunk('IEND'))),
			{
				code: 'unknown-critical',
				chunkType: 'TESt',
				phase: 'after-ihdr',
				ancillary: false,
				safeToCopy: true,
			},
		);
		expect(err.message).toContain('IHDR, PLTE, IDAT or IEND');
	});

	it('reports unsafe-to-copy unknown critical chunks too', () => {
		// 'TEST': all property bits clear.
		expectError(() => parsePng(build(ihdr(), chunk('TEST'))), {
			code: 'unknown-critical',
			chunkType: 'TEST',
			phase: 'after-ihdr',
			safeToCopy: false,
		});
	});

	it('rejects unknown critical chunks even between IDAT chunks', () => {
		expectError(
			() =>
				parsePng(
					build(
						ihdr(),
						chunk('IDAT', [1]),
						chunk('badC'), // lowercase b => ancillary; use critical instead
						chunk('IEND'),
					),
				),
			{ code: 'idat-interrupted', chunkType: 'badC' },
		);
		expectError(
			() =>
				parsePng(
					build(ihdr(), chunk('IDAT', [1]), chunk('BADc'), chunk('IEND')),
				),
			{ code: 'unknown-critical', chunkType: 'BADc', safeToCopy: true },
		);
	});
});

describe('IEND and stream termination', () => {
	it('requires at least one IDAT before IEND', () => {
		expectError(() => parsePng(build(ihdr(), chunk('IEND'))), {
			code: 'missing-idat',
			chunkType: 'IEND',
			phase: 'after-ihdr',
			expected: 'at least one IDAT chunk before IEND',
		});
	});

	it('reports missing IEND at end of input', () => {
		expectError(() => parsePng(build(ihdr(), chunk('IDAT', [1, 2, 3]))), {
			code: 'missing-iend',
			chunkType: null,
			phase: 'in-idat',
			expected: 'IEND to terminate the IDAT sequence',
		});
	});

	it('rejects a non-empty IEND data field', () => {
		expectError(
			() => parsePng(build(ihdr(), chunk('IDAT'), chunk('IEND', [0]))),
			{ code: 'invalid-iend', chunkType: 'IEND', phase: 'in-idat' },
		);
	});

	it('reports a truncated final chunk', () => {
		const bytes = build(ihdr());
		const partial = chunk('IDAT', [1, 2, 3]).slice(0, 10);
		expectError(() => parsePng(concatBytes(bytes, partial)), {
			code: 'truncated-chunk',
			phase: 'after-ihdr',
		});
	});
});

describe('trailing data after IEND', () => {
	it('rejects trailing bytes by default and never parses them as chunks', () => {
		// The trailing bytes look like another IHDR; they must not be parsed.
		const trailing = build(ihdr(), chunk('IDAT'), chunk('IEND'));
		const err = expectError(
			() =>
				parsePng(
					concatBytes(
						build(ihdr(), chunk('IDAT', [1]), chunk('IEND')),
						trailing,
					),
				),
			{ code: 'trailing-data', chunkType: null, phase: 'after-iend' },
		);
		expect(err.expected).toContain('IEND must be last');
	});

	it('keeps trailing bytes verbatim when configured, without parsing', () => {
		const trailing = new Uint8Array([0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);
		const doc = parsePng(
			concatBytes(build(ihdr(), chunk('IDAT'), chunk('IEND')), trailing),
			{ allowTrailingAfterIend: true },
		);
		expect(doc.phase).toBe('after-iend');
		expect(doc.trailing).toEqual(trailing);
		// No second header was installed.
		expect(doc.ihdr.width).toBe(1);
	});

	it('does not accept IDAT after IEND even with trailing allowed', () => {
		const fakeIdat = chunk('IDAT', [9, 9, 9]);
		const doc = parsePng(
			concatBytes(build(ihdr(), chunk('IDAT'), chunk('IEND')), fakeIdat),
			{ allowTrailingAfterIend: true },
		);
		expect(doc.idat).toEqual(Uint8Array.from([]));
		expect(doc.trailing).toEqual(fakeIdat);
	});

	it('handles trailing bytes arriving in later writes', () => {
		const parser = new PngParser({ allowTrailingAfterIend: true });
		parser.write(build(ihdr(), chunk('IDAT'), chunk('IEND')));
		parser.write(Uint8Array.from([0xab]));
		parser.write(Uint8Array.from([0xcd]));
		const doc = parser.end();
		expect(doc.trailing).toEqual(Uint8Array.from([0xab, 0xcd]));
	});
});

describe('chunk framing', () => {
	it('rejects type bytes outside A-Z / a-z', () => {
		const bad = build(ihdr());
		const frame = chunk('IDAT', [1]);
		frame[4] = 0x01;
		expectError(() => parsePng(concatBytes(bad, frame)), {
			code: 'invalid-chunk-type',
			phase: 'after-ihdr',
		});
	});

	it('computes property bits from type letters', () => {
		expect(chunkFlags('IDAT')).toEqual({
			ancillary: false,
			private: false,
			reserved: false,
			safeToCopy: false,
		});
		expect(chunkFlags('xTXt')).toEqual({
			ancillary: true,
			private: false,
			reserved: false,
			safeToCopy: true,
		});
	});
});

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}
