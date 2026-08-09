import { describe, expect, it } from "bun:test";
import { cosine, decodeVector, encodeVector } from "./vector";

describe("encodeVector / decodeVector", () => {
	it("round-trips a vector through float32 BLOB storage", () => {
		const original = [0.1, -0.5, 1.25, 3.0];
		const decoded = decodeVector(encodeVector(original));
		expect(decoded).not.toBeNull();
		expect(decoded!.length).toBe(original.length);
		for (let i = 0; i < original.length; i++) {
			expect(decoded![i]).toBeCloseTo(original[i] ?? 0, 5);
		}
	});

	it("returns null for null or empty buffers", () => {
		expect(decodeVector(null)).toBeNull();
		expect(decodeVector(new Uint8Array(0))).toBeNull();
	});

	it("handles misaligned buffer offsets by copying", () => {
		const encoded = encodeVector([1, 2, 3, 4]);
		const padded = new Uint8Array(encoded.length + 1);
		padded.set(encoded, 1);
		const misaligned = new Uint8Array(padded.buffer, 1, encoded.length);
		const decoded = decodeVector(misaligned);
		expect(decoded).not.toBeNull();
		expect(decoded![0]).toBeCloseTo(1, 5);
		expect(decoded![3]).toBeCloseTo(4, 5);
	});
});

describe("cosine", () => {
	it("returns 1 for identical directions", () => {
		expect(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([2, 4, 6]))).toBeCloseTo(1, 5);
	});

	it("returns 0 for orthogonal vectors", () => {
		expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5);
	});

	it("returns -1 for opposite directions", () => {
		expect(cosine(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1, 5);
	});

	it("returns 0 for empty or zero vectors", () => {
		expect(cosine(new Float32Array(0), Float32Array.from([1]))).toBe(0);
		expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
	});
});
