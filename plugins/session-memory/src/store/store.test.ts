import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemStore } from "./store";
import { encodeVector } from "../vector";
import { textHash } from "../workspace";
import type { ChunkInput } from "../types";

let workspace: string;
let store: MemStore;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "smem-store-"));
	store = MemStore.open(workspace);
});

afterEach(() => {
	store.close();
	rmSync(workspace, { recursive: true, force: true });
});

function chunk(text: string, turnNo = 1, role: "user" | "assistant" = "user"): ChunkInput {
	return { sessionId: "s1", role, turnNo, text, tokenEstimate: Math.ceil(text.length / 4) };
}

describe("MemStore — upsert + dedup", () => {
	it("inserts a new chunk and returns its id", () => {
		const res = store.upsertChunk(chunk("hello world"), textHash("hello world"), null, null);
		expect(res.inserted).toBe(true);
		expect(res.id).toBeGreaterThan(0);
	});

	it("dedups by (session_id, text_hash)", () => {
		const first = store.upsertChunk(chunk("same text"), textHash("same text"), null, null);
		const second = store.upsertChunk(chunk("same text"), textHash("same text"), null, null);
		expect(first.inserted).toBe(true);
		expect(second.inserted).toBe(false);
		expect(second.id).toBe(first.id);
		expect(store.count()).toBe(1);
	});

	it("allows the same text in different sessions", () => {
		store.upsertChunk(chunk("shared text"), textHash("shared text"), null, null);
		const other = { ...chunk("shared text"), sessionId: "s2" };
		const res = store.upsertChunk(other, textHash("shared text"), null, null);
		expect(res.inserted).toBe(true);
		expect(store.count()).toBe(2);
	});

	it("round-trips chunk rows through chunkById", () => {
		const res = store.upsertChunk(chunk("payload", 7, "assistant"), textHash("payload"), null, null);
		const row = store.chunkById(res.id);
		expect(row?.text).toBe("payload");
		expect(row?.turnNo).toBe(7);
		expect(row?.role).toBe("assistant");
		expect(row?.compacted).toBe(false);
		expect(store.chunkById(99999)).toBeNull();
	});
});

describe("MemStore — embeddings", () => {
	it("stores and decodes float32 embedding blobs", () => {
		const vec = encodeVector([0.5, -1.5, 2.25]);
		const res = store.upsertChunk(chunk("v"), textHash("v"), vec, "model-x");
		const row = store.chunkById(res.id);
		expect(row?.embeddingModel).toBe("model-x");
		expect(row?.embedding).not.toBeNull();
		expect(row!.embedding![0]).toBeCloseTo(0.5, 5);
	});

	it("vectorCandidates returns only same-model embedded rows", () => {
		store.upsertChunk(chunk("a"), textHash("a"), encodeVector([1]), "model-x");
		store.upsertChunk(chunk("b"), textHash("b"), encodeVector([1]), "model-y");
		store.upsertChunk(chunk("c"), textHash("c"), null, null);
		const candidates = store.vectorCandidates("model-x");
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.text).toBe("a");
	});

	it("updateEmbedding replaces an existing embedding", () => {
		const res = store.upsertChunk(chunk("u"), textHash("u"), encodeVector([0]), "old");
		store.updateEmbedding(res.id, encodeVector([1, 2]), "new");
		const row = store.chunkById(res.id);
		expect(row?.embeddingModel).toBe("new");
		expect(row!.embedding![1]).toBeCloseTo(2, 5);
	});
});

describe("MemStore — compaction, clear, meta", () => {
	it("markAllCompacted flags non-compacted rows once", () => {
		store.upsertChunk(chunk("a"), textHash("a"), null, null);
		store.upsertChunk(chunk("b"), textHash("b"), null, null);
		expect(store.markAllCompacted()).toBe(2);
		expect(store.countCompacted()).toBe(2);
		expect(store.markAllCompacted()).toBe(0);
	});

	it("clear removes every chunk", () => {
		store.upsertChunk(chunk("a"), textHash("a"), null, null);
		store.upsertChunk(chunk("b"), textHash("b"), null, null);
		expect(store.clear()).toBe(2);
		expect(store.count()).toBe(0);
	});

	it("persists meta values with upsert semantics", () => {
		expect(store.getMeta("config")).toBeNull();
		store.setMeta("config", '{"a":1}');
		store.setMeta("config", '{"a":2}');
		expect(store.getMeta("config")).toBe('{"a":2}');
	});
});
