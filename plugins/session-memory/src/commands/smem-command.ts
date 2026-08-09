/**
 * /smem command — routes: stats | config <key> <json> | rebuild | clear.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SmemRuntime } from "../runtime";
import { ensureStore, persistConfig } from "../runtime";
import { formatConfig, setConfigKey } from "../config";
import { aggregateTelemetry } from "../telemetry";
import { encodeVector } from "../vector";
import { telemetryPath } from "../workspace";

/** Register the /smem command with subcommand routing. */
export function registerSmemCommand(pi: ExtensionAPI, rt: SmemRuntime): void {
	pi.registerCommand("smem", {
		description: "Session Memory: stats | config <key> <json> | rebuild | clear",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
			const sub = parts[0] ?? "";
			try {
				await routeSubcommand(sub, parts.slice(1), rt, ctx);
			} catch (e) {
				notify(ctx, `/smem ${sub} failed: ${(e as Error).message}`, "error");
			}
		},
	});
}

/** Route to the appropriate subcommand handler. */
async function routeSubcommand(sub: string, args: string[], rt: SmemRuntime, ctx: ExtensionCommandContext): Promise<void> {
	switch (sub) {
		case "stats":
			return cmdStats(rt, ctx);
		case "config":
			return cmdConfig(rt, ctx, args);
		case "rebuild":
			return cmdRebuild(rt, ctx);
		case "clear":
			return cmdClear(rt, ctx);
		default:
			notify(ctx, "Usage: /smem <stats|config <key> <json>|rebuild|clear>", "warning");
	}
}

/** Show index + telemetry stats. */
function cmdStats(rt: SmemRuntime, ctx: ExtensionCommandContext): void {
	const store = ensureStore(rt, ctx.cwd);
	if (!store) return notify(ctx, "Session Memory not initialised.", "warning");
	const agg = aggregateTelemetry(telemetryPath(ctx.cwd));
	const pct = `${Math.round(agg.cacheHitRatio * 100)}%`;
	notify(ctx, [
		`mode: ${rt.configRef.current.mode}`,
		`chunks: ${store.count()} (${store.countEmbedded()} embedded, ${store.countCompacted()} compacted)`,
		`turns: ${agg.turns} · cache-hit: ${pct}`,
	].join("\n"), "info");
}

/** Show or set config. */
function cmdConfig(rt: SmemRuntime, ctx: ExtensionCommandContext, args: string[]): void {
	const store = ensureStore(rt, ctx.cwd);
	if (!store) return notify(ctx, "Session Memory not initialised.", "warning");
	if (args.length === 0) return notify(ctx, formatConfig(rt.configRef.current), "info");
	const key = args[0];
	if (!key) return notify(ctx, "config: missing key", "warning");
	const jsonValue = args.slice(1).join(" ");
	try {
		rt.configRef.current = setConfigKey(rt.configRef.current, key, jsonValue);
		persistConfig(rt);
		notify(ctx, `Set ${key} = ${jsonValue}`, "info");
	} catch (e) {
		notify(ctx, `config failed: ${(e as Error).message}`, "error");
	}
}

/** Re-embed every chunk with the current endpoint chain. */
async function cmdRebuild(rt: SmemRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const store = ensureStore(rt, ctx.cwd);
	const chain = rt.chainRef.current;
	if (!store || !chain) return notify(ctx, "Session Memory not initialised (no endpoint chain).", "warning");
	const candidates = store.chunksToReembed();
	if (candidates.length === 0) return notify(ctx, "No chunks to re-embed.", "info");
	let ok = 0;
	for (const candidate of candidates) {
		// Sequential: re-embedding hits a possibly slow/noisy local endpoint; do not
		// fan out unbounded parallelism at the user's GPU box.
		// eslint-disable-next-line no-await-in-loop
		const result = await chain.embed(candidate.text);
		if (result) {
			store.updateEmbedding(candidate.id, encodeVector(result.vector), result.model);
			ok++;
		}
	}
	notify(ctx, `Re-embedded ${ok}/${candidates.length} chunks.`, "info");
}

/** Delete every chunk. */
function cmdClear(rt: SmemRuntime, ctx: ExtensionCommandContext): void {
	const store = ensureStore(rt, ctx.cwd);
	if (!store) return notify(ctx, "Session Memory not initialised.", "warning");
	const deleted = store.clear();
	notify(ctx, `Cleared ${deleted} chunks.`, "info");
}

/** Notify the user when the UI is available. */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}
