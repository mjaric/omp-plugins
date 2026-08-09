/**
 * smem_status — endpoint-chain health, index size, and active mode (spec §9).
 */

import { type } from "@oh-my-pi/omptype";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SmemRuntime } from "../runtime";
import { ensureStore, notInitialisedResult, textResult } from "../runtime";
import type { EndpointHealth } from "../types";

const schema = type({});

/** Register the smem_status tool. */
export function registerStatusTool(pi: ExtensionAPI, rt: SmemRuntime): void {
	pi.registerTool({
		name: "smem_status",
		label: "Session Memory Status",
		description:
			"Report the embedding endpoint-chain health (first-healthy-wins + cooldown), index size, and active recall mode. Use this to diagnose why recall returns nothing.",
		parameters: schema.toJsonSchema(),
		approval: "read",
		async execute(_id, _p, _signal, _onUpdate, ctx) {
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			const chain = rt.chainRef.current;
			const health = chain ? chain.health() : [];
			const mode = rt.configRef.current.mode;
			return textResult(formatStatus(mode, store.count(), store.countEmbedded(), health), {
				mode,
				chunkCount: store.count(),
				embeddedCount: store.countEmbedded(),
				endpoints: health,
			});
		},
	});
}

/** Format the status block for the model. */
function formatStatus(mode: string, chunks: number, embedded: number, health: EndpointHealth[]): string {
	const endpointLines = health.length === 0
		? "  (none — set SMEM_ENDPOINTS or /smem config endpoints)"
		: health
				.map(h => {
					const state = h.healthy
						? "healthy"
						: `cooling down${h.cooldownUntil ? ` until ${new Date(h.cooldownUntil).toISOString()}` : ""}`;
					return `  - ${h.name} [${h.model}]: ${state}${h.lastError ? ` — ${h.lastError}` : ""}`;
				})
				.join("\n");
	return [`mode: ${mode}`, `chunks: ${chunks} (${embedded} embedded)`, "endpoints:", endpointLines].join("\n");
}
