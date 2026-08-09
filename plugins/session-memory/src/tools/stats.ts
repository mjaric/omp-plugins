/**
 * smem_stats — per-session index + telemetry aggregates (spec §8, §9).
 */

import { type } from "@oh-my-pi/omptype";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SmemRuntime } from "../runtime";
import { ensureStore, notInitialisedResult, textResult } from "../runtime";
import { aggregateTelemetry, type TelemetryAggregate } from "../telemetry";
import { telemetryPath } from "../workspace";
import type { SessionStats } from "../types";

const schema = type({});

/** Register the smem_stats tool. */
export function registerStatsTool(pi: ExtensionAPI, rt: SmemRuntime): void {
	pi.registerTool({
		name: "smem_stats",
		label: "Session Memory Stats",
		description:
			"Show session-memory index size (chunks, embedded, compacted), recall mode, and telemetry aggregates (cache-hit ratio, injected/deduped chunk totals).",
		parameters: schema.toJsonSchema(),
		approval: "read",
		async execute(_id, _p, _signal, _onUpdate, ctx) {
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			const aggregate = aggregateTelemetry(telemetryPath(ctx.cwd));
			const stats: SessionStats = {
				mode: rt.configRef.current.mode,
				chunkCount: store.count(),
				embeddedCount: store.countEmbedded(),
				compactedCount: store.countCompacted(),
				turns: aggregate.turns,
				storePath: store.path,
				telemetryPath: telemetryPath(ctx.cwd),
			};
			return textResult(formatStats(stats, aggregate), { stats, aggregate });
		},
	});
}

/** Format the stats block for the model. */
function formatStats(stats: SessionStats, agg: TelemetryAggregate): string {
	const pct = `${Math.round(agg.cacheHitRatio * 100)}%`;
	return [
		`mode: ${stats.mode}`,
		`chunks: ${stats.chunkCount} (${stats.embeddedCount} embedded, ${stats.compactedCount} compacted)`,
		`telemetry turns: ${stats.turns}`,
		`cache-hit ratio: ${pct} (cacheRead ${agg.totalCacheRead} / input+cacheRead ${agg.totalInput + agg.totalCacheRead})`,
		`injected chunks: ${agg.totalInjectedChunks} total · deduped: ${agg.totalDedupedChunks} total`,
		`avg recall: ${agg.avgRecallMs}ms`,
		`store: ${stats.storePath}`,
	].join("\n");
}
