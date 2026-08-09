/**
 * float32 vector (de)serialisation and cosine similarity — pure helpers.
 *
 * Vectors are stored as little-endian float32 BLOBs in SQLite. Cosine is the
 * sole ranking metric for v1 (brute force, spec §4); an ANN index is deferred.
 */

/** Encode a number vector as a little-endian float32 buffer for BLOB storage. */
export function encodeVector(vec: readonly number[]): Uint8Array {
	const buffer = new Float32Array(vec);
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** Decode a stored BLOB back into a Float32Array (null-safe). */
export function decodeVector(buf: Uint8Array | null): Float32Array | null {
	if (!buf || buf.byteLength === 0) return null;
	const view = buf.byteOffset % 4 === 0
		? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
		: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
	return view;
}

/** Cosine similarity in [-1, 1]; 0 when either vector is empty/zero. */
export function cosine(a: Float32Array, b: Float32Array): number {
	const len = Math.min(a.length, b.length);
	if (len === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < len; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
