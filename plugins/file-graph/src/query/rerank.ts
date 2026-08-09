/**
 * Reranker interface — optional second-stage ranking (spec §7).
 *
 * Rerank is OFF by default and every query works without it. The interface
 * exists so a wave-2 implementation can plug in an OpenAI-compatible endpoint
 * chain. No HTTP calls are made in this wave.
 */

import type { SearchHit } from "../types";

/**
 * Reranks the top-N lexical+graph candidates for a query.
 * Implementations may reorder, filter, or annotate hits.
 */
export interface Reranker {
	readonly name: string;
	rerank(query: string, hits: SearchHit[], topN: number): Promise<SearchHit[]>;
}

/** No-op reranker — the default when rerank is disabled. */
export const NOOP_RERANKER: Reranker = {
	name: "disabled",
	async rerank(_query, hits) {
		return hits;
	},
};
