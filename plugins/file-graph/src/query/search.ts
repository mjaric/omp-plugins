/**
 * Query engine — two-stage search (spec §7).
 *
 * Stage 1 (always on): lexical matching via FTS5/LIKE, aggregated per file,
 *   boosted by 1-hop graph expansion from the matched files' entities.
 * Stage 2 (optional, off by default): rerank the top-N candidates through a
 *   configured reranker endpoint. Every query works without stage 2.
 */

import type { SearchAnchor, SearchHit } from "../types";
import type { GraphStore, SearchIndexRow } from "../store/store";
import { NOOP_RERANKER, type Reranker } from "./rerank";

/** Options controlling search behaviour. */
export interface SearchOptions {
	limit?: number | undefined;
	/** Run 1-hop graph expansion (default true). */
	expandGraph?: boolean;
	/** Optional reranker for the top-N candidates. */
	reranker?: Reranker;
	rerankTopN?: number;
}

/** Score boost per graph edge to a connected file. */
const GRAPH_BOOST = 0.3;

/** Run a graph search, returning ranked hits with anchors and relation context. */
export async function search(
	store: GraphStore,
	query: string,
	options: SearchOptions = {},
): Promise<SearchHit[]> {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [];

	const limit = options.limit ?? 20;
	const rows = store.searchIndex(trimmed, limit * 3);
	const scored = aggregateFileScores(rows);
	if (options.expandGraph !== false) applyGraphExpansion(store, scored);

	const filesById = mapByKey(store.listFiles(), f => f.id);

	const sorted = [...scored.entries()]
		.toSorted((a, b) => b[1].score - a[1].score)
		.slice(0, limit)
		.map(([fileId, data]) => buildHit(fileId, data, filesById))
		.filter((h): h is SearchHit => h !== null);

	return rerankTop(query, sorted, options);
}

/** Apply the optional reranker to the top-N slice of results. */
async function rerankTop(
	query: string,
	hits: SearchHit[],
	options: SearchOptions,
): Promise<SearchHit[]> {
	const reranker = options.reranker ?? NOOP_RERANKER;
	const topN = options.rerankTopN ?? 12;
	if (reranker.name === "disabled" || hits.length <= topN) return hits;
	const reranked = await reranker.rerank(query, hits.slice(0, topN), topN);
	return [...reranked, ...hits.slice(topN)];
}

/** Aggregate search-index rows into per-file score + anchor collections. */
function aggregateFileScores(
	rows: SearchIndexRow[],
): Map<number, { score: number; anchors: SearchAnchor[] }> {
	const map = new Map<number, { score: number; anchors: SearchAnchor[] }>();
	for (const row of rows) {
		let entry = map.get(row.fileId);
		if (!entry) {
			entry = { score: 0, anchors: [] };
			map.set(row.fileId, entry);
		}
		entry.score += row.score;
		entry.anchors.push({
			kind: row.kind as SearchAnchor["kind"],
			text: row.text,
			line: row.line,
		});
	}
	return map;
}

/** Boost scores of files connected via 1-hop entity relations. */
function applyGraphExpansion(
	store: GraphStore,
	scored: Map<number, { score: number; anchors: SearchAnchor[] }>,
): void {
	const matched = new Set(scored.keys());
	for (const fileId of matched) {
		for (const entityId of getEntityIdsForFile(store, fileId)) {
			boostConnectedFiles(store, entityId, scored, matched);
		}
	}
}

/** Add graph boost to files sharing a relation with `entityId`. */
function boostConnectedFiles(
	store: GraphStore,
	entityId: number,
	scored: Map<number, { score: number; anchors: SearchAnchor[] }>,
	matched: Set<number>,
): void {
	for (const rel of store.getRelationsForEntity(entityId)) {
		const other = rel.srcFileId;
		if (matched.has(other)) continue;
		const entry = scored.get(other) ?? { score: 0, anchors: [] };
		entry.score += GRAPH_BOOST;
		scored.set(other, entry);
	}
}

/** Collect entity ids referenced in a file's relations. */
function getEntityIdsForFile(store: GraphStore, fileId: number): number[] {
	const ids = new Set<number>();
	for (const r of store.getRelationsForFile(fileId)) {
		if (r.srcEntityId !== null) ids.add(r.srcEntityId);
		if (r.dstEntityId !== null) ids.add(r.dstEntityId);
	}
	return [...ids];
}

/** Build a SearchHit from aggregated score data, or null if the file is gone. */
function buildHit(
	fileId: number,
	data: { score: number; anchors: SearchAnchor[] },
	filesById: Map<number, { path: string; title: string | null; purpose: string | null }>,
): SearchHit | null {
	const file = filesById.get(fileId);
	if (!file) return null;
	return {
		fileId,
		path: file.path,
		title: file.title,
		purpose: file.purpose,
		score: Math.round(data.score * 1000) / 1000,
		anchors: dedupeAnchors(data.anchors),
		relations: [],
	};
}

/** Deduplicate anchors by (kind, text). */
function dedupeAnchors(anchors: SearchAnchor[]): SearchAnchor[] {
	const seen = new Set<string>();
	const out: SearchAnchor[] = [];
	for (const a of anchors) {
		const key = `${a.kind}:${a.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(a);
	}
	return out;
}

/** Build a `Map` from an array using a key extractor. */
function mapByKey<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T> {
	const map = new Map<K, T>();
	for (const item of items) map.set(keyFn(item), item);
	return map;
}

/** Compute candidate suggestions for a prompt (agent-driven alternative to alt-g). */
export function suggest(
	store: GraphStore,
	prompt: string,
	limit: number,
): Promise<SearchHit[]> {
	return search(store, prompt, { limit, expandGraph: true });
}
