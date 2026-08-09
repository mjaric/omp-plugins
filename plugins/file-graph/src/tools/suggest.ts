/**
 * fg_suggest — agent-driven candidate computation for the current prompt.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { FileGraphRuntime } from "./shared";
import { ensureStore, notInitialisedResult, textResult } from "./shared";
import { suggest } from "../query/search";

/** Register the fg_suggest tool. */
export function registerSuggestTool(pi: ExtensionAPI, rt: FileGraphRuntime): void {
	const T = pi.typebox.Type;
	const params = T.Object({
		prompt: T.String({ description: "the current user prompt or task description" }),
		limit: T.Optional(T.Number({ description: "max candidates (default 10)" })),
	});

	pi.registerTool({
		name: "fg_suggest",
		label: "File Graph Suggest",
		description:
			"Compute graph candidates relevant to a prompt but not necessarily in context. Agent-driven alternative to the interactive alt-g suggestion flow.",
		parameters: params,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			const hits = await suggest(store, p.prompt, p.limit ?? 10);
			return textResult(formatSuggestions(hits), { prompt: p.prompt, count: hits.length, candidates: hits });
		},
	});
}

/** Format suggestions as a readable text block. */
function formatSuggestions(hits: { path: string; title: string | null; score: number }[]): string {
	if (hits.length === 0) return "No relevant candidates found.";
	return hits
		.map((h, i) => {
			const title = h.title ? ` — ${h.title}` : "";
			return `${i + 1}. ${h.path}${title} (relevance ${h.score})`;
		})
		.join("\n");
}
