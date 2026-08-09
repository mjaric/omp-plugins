/**
 * Shared domain types for the session-memory plugin.
 *
 * Pure types + the default config constant. No runtime logic lives here so the
 * store, chunking, recall, and telemetry modules can depend on it without
 * pulling in each other.
 */

/** Recall/injection mode. `naive` exists only as the A/B baseline (spec §7). */
export type RecallMode = "off" | "naive" | "prefix-safe";

/** One OpenAI-compatible `/embeddings` endpoint in the ordered chain (spec §5). */
export interface EndpointConfig {
	name: string;
	baseUrl: string;
	/** Optional Bearer/API key; omitted for local ollama. */
	apiKey?: string;
	model: string;
	/** Embedding dimension, recorded for sanity checks when known. */
	dimensions?: number;
}

/** Plugin configuration, persisted in the store `meta` table under "config". */
export interface SmemConfig {
	mode: RecallMode;
	endpoints: EndpointConfig[];
	/** Number of chunks retrieved before dedup (spec §7.2, default 8). */
	topK: number;
	/** Fixed cosine bonus added to `compacted = true` chunks (spec §7.2). */
	compactedBoost: number;
	/** Soft size cap per chunk in estimated tokens (spec §6.1, ~1200). */
	maxChunkTokens: number;
	/** Cooldown applied to a failed endpoint before it is retried. */
	cooldownMs: number;
}

/** Default config: prefix-safe recall, no endpoints configured yet. */
export const DEFAULT_CONFIG: SmemConfig = {
	mode: "prefix-safe",
	endpoints: [],
	topK: 8,
	compactedBoost: 0.1,
	maxChunkTokens: 1200,
	cooldownMs: 30_000,
};

/** Message roles that are eligible for indexing (spec §6.1). */
export type IndexedRole = "user" | "assistant";

/** A chunk ready to be persisted (before embedding). */
export interface ChunkInput {
	sessionId: string;
	role: IndexedRole;
	turnNo: number;
	text: string;
	tokenEstimate: number;
}

/** A persisted chunk row. `embedding` is null until the chain succeeds. */
export interface ChunkRow {
	id: number;
	sessionId: string;
	role: IndexedRole;
	turnNo: number;
	text: string;
	textHash: string;
	embedding: Float32Array | null;
	embeddingModel: string | null;
	tokenEstimate: number;
	createdAt: number;
	compacted: boolean;
}

/** A chunk paired with its cosine score against the query. */
export interface ScoredChunk {
	chunk: ChunkRow;
	score: number;
}

/** Lightweight attribution used in the recall package (titles only). */
export interface ChunkRef {
	turnNo: number;
	role: IndexedRole;
}

/** A new chunk carried in the recall package, with attribution text. */
export interface RecallChunk {
	id: number;
	turnNo: number;
	role: IndexedRole;
	text: string;
	score: number;
}

/** The recall package built by the read path and consumed by the context handler. */
export interface RecallPackage {
	mode: RecallMode;
	/** Present-but-not-reinjected chunks, listed by turn/role only (spec §7.4). */
	references: ChunkRef[];
	/** Genuinely new chunks, with full text + attribution. */
	chunks: RecallChunk[];
	injectedChunks: number;
	injectedChars: number;
	dedupedChunks: number;
	recallMs: number;
}

/** One append-only telemetry row written to `turns.jsonl` (spec §8). */
export interface TelemetryRow {
	ts: string;
	mode: RecallMode;
	turnNo: number;
	inputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	injectedChunks: number;
	injectedChars: number;
	dedupedChunks: number;
	recallMs: number;
}

/** Per-session aggregates surfaced by `smem_stats` / `/smem stats`. */
export interface SessionStats {
	mode: RecallMode;
	chunkCount: number;
	embeddedCount: number;
	compactedCount: number;
	turns: number;
	storePath: string;
	telemetryPath: string;
}

/** Endpoint health snapshot returned by `smem_status`. */
export interface EndpointHealth {
	name: string;
	model: string;
	healthy: boolean;
	cooldownUntil: number | null;
	lastError: string | null;
}
