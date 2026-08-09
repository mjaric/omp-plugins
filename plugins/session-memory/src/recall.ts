/**
 * Read path — prefix-safe recall (spec §7).
 *
 * Embed the query, brute-force cosine top-k over same-model vectors (compacted
 * chunks score a fixed bonus), then dedup two ways in `prefix-safe` mode: an
 * injection ledger (chunk ids already injected this session) and a content-hash
 * match against the current context. `naive` skips dedup (A/B baseline); `off`
 * emits nothing.
 */

import type { EmbeddingChain, EmbedResult } from "./embedding";
import type { MemStore } from "./store/store";
import { cosine } from "./vector";
import type {
	ChunkRef,
	ChunkRow,
	RecallChunk,
	RecallMode,
	RecallPackage,
	SmemConfig,
} from "./types";

/** Inputs to a recall pass. `queryText` is the prompt + recent turns joined by the caller. */
export interface RecallInput {
	store: MemStore;
	chain: EmbeddingChain;
	config: SmemConfig;
	sessionId: string;
	queryText: string;
	/** Chunk ids already injected this session (rebuilt from the session ledger). */
	injectedLedger: Set<number>;
	/** Text hashes currently present in the LLM context. */
	contextHashes: Set<string>;
}

/** Build a recall package for the given query + dedup inputs. */
export async function buildRecallPackage(input: RecallInput, signal?: AbortSignal): Promise<RecallPackage> {
	const startedAt = Date.now();
	const empty = (ms: number): RecallPackage => ({
		mode: input.config.mode,
		references: [],
		chunks: [],
		injectedChunks: 0,
		injectedChars: 0,
		dedupedChunks: 0,
		recallMs: ms,
	});
	if (input.config.mode === "off" || input.queryText.trim().length === 0) {
		return empty(elapsedSince(startedAt));
	}
	const embed = await input.chain.embed(input.queryText, signal);
	if (embed === null) return empty(elapsedSince(startedAt));
	const topK = scoreTopK(input.store, input.config, embed);
	if (topK.length === 0) return empty(elapsedSince(startedAt));
	return assemblePackage(input.config.mode, topK, input.injectedLedger, input.contextHashes, elapsedSince(startedAt));
}

/** Score every same-model candidate and return the top-k. */
function scoreTopK(store: MemStore, config: SmemConfig, embed: EmbedResult): Scored[] {
	const query = Float32Array.from(embed.vector);
	const candidates = store.vectorCandidates(embed.model);
	const scored: Scored[] = candidates.map(row => {
		const base = row.embedding ? cosine(query, row.embedding) : 0;
		return { row, score: base + (row.compacted ? config.compactedBoost : 0) };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, config.topK);
}

/** Apply mode-aware dedup and assemble the final package. */
function assemblePackage(
	mode: RecallMode,
	topK: Scored[],
	injectedLedger: Set<number>,
	contextHashes: Set<string>,
	recallMs: number,
): RecallPackage {
	if (mode === "naive") {
		return packageFrom(mode, topK, [], 0, recallMs);
	}
	const present: Scored[] = [];
	const fresh: Scored[] = [];
	for (const item of topK) {
		if (injectedLedger.has(item.row.id) || contextHashes.has(item.row.textHash)) {
			present.push(item);
		} else {
			fresh.push(item);
		}
	}
	return packageFrom(mode, fresh, present.map(toRef), present.length, recallMs);
}

/** Build the package from the new chunks (+ references + counts). */
function packageFrom(mode: RecallMode, fresh: Scored[], references: ChunkRef[], dedupedChunks: number, recallMs: number): RecallPackage {
	const chunks: RecallChunk[] = fresh.map(item => ({
		id: item.row.id,
		turnNo: item.row.turnNo,
		role: item.row.role,
		text: item.row.text,
		score: item.score,
	}));
	return {
		mode,
		references,
		chunks,
		injectedChunks: chunks.length,
		injectedChars: chunks.reduce((sum, c) => sum + c.text.length, 0),
		dedupedChunks,
		recallMs,
	};
}

interface Scored {
	row: ChunkRow;
	score: number;
}

/** Map a scored chunk to a turn/role reference (titles only, no content). */
function toRef(item: Scored): ChunkRef {
	return { turnNo: item.row.turnNo, role: item.row.role };
}

function elapsedSince(startedAt: number): number {
	return Date.now() - startedAt;
}
