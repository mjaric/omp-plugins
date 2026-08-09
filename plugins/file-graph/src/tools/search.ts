/**
 * fg_search — query the graph (lexical + graph, optional rerank).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { FileGraphRuntime } from "./shared";
import { ensureStore, notInitialisedResult, textResult } from "./shared";
import { search } from "../query/search";

/** Register the fg_search tool. */
export function registerSearchTool(pi: ExtensionAPI, rt: FileGraphRuntime): void {
	const T = pi.typebox.Type;
	const params = T.Object({
		query: T.String({ description: "search terms" }),
		limit: T.Optional(T.Number({ description: "max hits (default 20)" })),
	});

	pi.registerTool({
		name: "fg_search",
		label: "File Graph Search",
		description:
			"Search the workspace knowledge graph. Returns ranked files with heading/entity anchors and relation context. Uses full-text search plus 1-hop graph expansion.",
		parameters: params,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			const hits = await search(store, p.query, {
				limit: p.limit,
				reranker: rt.reranker,
				rerankTopN: rt.configRef.current.rerankTopN,
			});
			return textResult(formatSearchHits(hits), { query: p.query, count: hits.length, hits });
		},
	});
}

/** Format search hits as a readable text block for the model. */
function formatSearchHits(hits: { path: string; title: string | null; score: number; anchors: { kind: string; text: string }[] }[]): string {
	if (hits.length === 0) return "No matches found.";
	const lines = hits.map((h, i) => {
		const title = h.title ? ` — ${h.title}` : "";
		const anchors = h.anchors.map(a => `${a.kind}:${a.text}`).join(", ");
		return `${i + 1}. ${h.path}${title} (score ${h.score})\n   anchors: ${anchors}`;
	});
	return lines.join("\n");
}
