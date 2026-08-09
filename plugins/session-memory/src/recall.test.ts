import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemStore } from "./store/store";
import { buildRecallPackage } from "./recall";
import { EmbeddingChain } from "./embedding";
import type { EmbedResponse } from "./embedding";
import { encodeVector } from "./vector";
import { textHash } from "./workspace";
import type { ChunkInput, SmemConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

let workspace: string;
let store: MemStore;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "smem-recall-"));
	store = MemStore.open(workspace);
});

afterEach(() => {
	store.close();
	rmSync(workspace, { recursive: true, force: true });
});

function seed(text: string, turnNo: number, embedding: number[], model = "m1"): number {
	const input: ChunkInput = { sessionId: "s1", role: "assistant", turnNo, text, tokenEstimate: 4 };
	const res = store.upsertChunk(input, textHash(text), encodeVector(embedding), model);
	return res.id;
}

/** Chain whose endpoint returns a fixed query vector. */
function fixedChain(vector: number[]): EmbeddingChain {
	return new EmbeddingChain(
		[{ name: "e", baseUrl: "http://e.test", model: "m1" }],
		async (): Promise<EmbedResponse> => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [{ embedding: vector }] }),
			text: async () => "",
		}),
	);
}

function config(mode: SmemConfig["mode"], overrides: Partial<SmemConfig> = {}): SmemConfig {
	return { ...DEFAULT_CONFIG, mode, endpoints: [{ name: "e", baseUrl: "http://e.test", model: "m1" }], ...overrides };
}

describe("buildRecallPackage — modes", () => {
	it("returns an empty package in off mode without calling the chain", async () => {
		seed("content", 1, [1, 0]);
		const pkg = await buildRecallPackage({
			store,
			chain: fixedChain([1, 0]),
			config: config("off"),
			sessionId: "s1",
			queryText: "content",
			injectedLedger: new Set(),
			contextHashes: new Set(),
		});
		expect(pkg.mode).toBe("off");
		expect(pkg.chunks).toHaveLength(0);
	});

	it("returns an empty package for a blank query", async () => {
		seed("content", 1, [1, 0]);
		const pkg = await buildRecallPackage({
			store,
			chain: fixedChain([1, 0]),
			config: config("prefix-safe"),
			sessionId: "s1",
			queryText: "   ",
			injectedLedger: new Set(),
			contextHashes: new Set(),
		});
		expect(pkg.chunks).toHaveLength(0);
	});

	it("returns an empty package when every endpoint fails", async () => {
		seed("content", 1, [1, 0]);
		const failing = new EmbeddingChain(
			[{ name: "e", baseUrl: "http://e.test", model: "m1" }],
			async () => {
				throw new Error("down");
			},
		);
		const pkg = await buildRecallPackage({
			store,
			chain: failing,
			config: config("prefix-safe"),
			sessionId: "s1",
			queryText: "content",
			injectedLedger: new Set(),
			contextHashes: new Set(),
		});
		expect(pkg.chunks).toHaveLength(0);
	});

	it("naive mode injects the full top-k with no dedup", async () => {
		const id = seed("already covered", 3, [1, 0]);
		const pkg = await buildRecallPackage({
			store,
			chain: fixedChain([1, 0]),
			config: config("naive"),
			sessionId: "s1",
			queryText: "already covered",
			injectedLedger: new Set([id]),
			contextHashes: new Set([textHash("already covered")]),
		});
		expect(pkg.mode).toBe("naive");
		expect(pkg.chunks).toHaveLength(1);
		expect(pkg.references).toHaveLength(0);
		expect(pkg.dedupedChunks).toBe(0);
	});
});

describe("buildRecallPackage — prefix-safe dedup", () => {
	it("splits top-k into fresh chunks and reference-only entries", async () => {
		const injectedId = seed("covered material", 2, [0.9, 0.1]);
		const inContext = "material visible in the context";
		seed(inContext, 3, [0.85, 0.15]);
		seed("brand new insight", 4, [0.8, 0.2]);

		const pkg = await buildRecallPackage({
			store,
			chain: fixedChain([1, 0]),
			config: config("prefix-safe"),
			sessionId: "s1",
			queryText: "material",
			injectedLedger: new Set([injectedId]),
			contextHashes: new Set([textHash(inContext)]),
		});

		expect(pkg.chunks.map(c => c.text)).toEqual(["brand new insight"]);
		expect(pkg.references).toHaveLength(2);
		expect(pkg.references.map(r => r.turnNo).toSorted()).toEqual([2, 3]);
		expect(pkg.dedupedChunks).toBe(2);
		expect(pkg.injectedChunks).toBe(1);
		expect(pkg.injectedChars).toBe("brand new insight".length);
	});

	it("ranks by cosine and applies the compacted boost", async () => {
		// Identical base similarity; the compacted row must win via the boost.
		// Seed + compact "boosted row" first; the later "plain row" stays unflagged.
		store.upsertChunk(
			{ sessionId: "s1", role: "assistant", turnNo: 2, text: "boosted row", tokenEstimate: 3 },
			textHash("boosted row"),
			encodeVector([1, 0]),
			"m1",
		);
		store.markAllCompacted();
		seed("plain row", 1, [1, 0]);

		const pkg = await buildRecallPackage({
			store,
			chain: fixedChain([1, 0]),
			config: config("prefix-safe", { topK: 2, compactedBoost: 0.25 }),
			sessionId: "s1",
			queryText: "row",
			injectedLedger: new Set(),
			contextHashes: new Set(),
		});
		expect(pkg.chunks[0]?.text).toBe("boosted row");
	});

	it("respects topK", async () => {
		for (let i = 0; i < 5; i++) seed(`row ${i}`, i + 1, [1, 0.01 * i]);
		const pkg = await buildRecallPackage({
			store,
			chain: fixedChain([1, 0]),
			config: config("prefix-safe", { topK: 3 }),
			sessionId: "s1",
			queryText: "row",
			injectedLedger: new Set(),
			contextHashes: new Set(),
		});
		expect(pkg.chunks.length).toBeLessThanOrEqual(3);
	});
});
