/**
 * /fg command — routes subcommands: reindex | export | stats | config | view.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { FileGraphRuntime } from "../tools/shared";
import { ensureStore, resetStore } from "../tools/shared";
import { reindex } from "../indexer";
import { resolveProfile } from "../profiles/profiles";
import { formatConfig, saveConfig, setConfigKey } from "../config/config";
import { generateGraphExport, generateUbiquitousLanguage } from "../query/export";
import { generateMermaid } from "../query/graph";

/** Register the /fg command with subcommand routing. */
export function registerFgCommand(pi: ExtensionAPI, rt: FileGraphRuntime): void {
	pi.registerCommand("fg", {
		description: "File Graph: reindex | export | stats | config | view",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
			const sub = parts[0] ?? "";
			try {
				await routeSubcommand(sub, parts.slice(1), rt, ctx);
			} catch (e) {
				notify(ctx, `/fg ${sub} failed: ${(e as Error).message}`, "error");
			}
		},
	});
}

/** Route to the appropriate subcommand handler. */
async function routeSubcommand(
	sub: string,
	args: string[],
	rt: FileGraphRuntime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	switch (sub) {
		case "reindex":
			return cmdReindex(rt, ctx);
		case "stats":
			return cmdStats(rt, ctx);
		case "config":
			return cmdConfig(rt, ctx, args);
		case "export":
			return cmdExport(rt, ctx, args);
		case "view":
			return cmdView(rt, ctx);
		default:
			notify(ctx, `Usage: /fg <reindex|export|stats|config|view>`, "warning");
	}
}

/** Reindex the workspace and report the summary. */
function cmdReindex(rt: FileGraphRuntime, ctx: ExtensionCommandContext): void {
	const store = ensureStore(rt, ctx.cwd);
	if (!store) return notify(ctx, "File Graph: could not open store", "error");
	const profile = resolveProfile(rt.configRef.current.profile, rt.configRef.current.namespaces);
	const result = reindex(store, ctx.cwd, profile);
	const total = result.added + result.updated;
	notify(
		ctx,
		`File Graph: ${total} changed (${result.added} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.deleted} deleted) in ${result.durationMs}ms`,
		"info",
	);
}

/** Show graph statistics. */
function cmdStats(rt: FileGraphRuntime, ctx: ExtensionCommandContext): void {
	const store = ensureStore(rt, ctx.cwd);
	if (!store) return notify(ctx, "File Graph: could not open store", "error");
	const files = store.listFiles();
	const entities = store.listEntities();
	const relations = store.allRelations();
	const dangling = entities.filter(e => e.defFileId === null).map(e => e.name);
	const lines = [
		`files: ${files.length}  entities: ${entities.length}  relations: ${relations.length}`,
		`dangling: ${dangling.length}${dangling.length > 0 ? ` (${dangling.join(", ")})` : ""}`,
		`store: ${store.path}`,
	];
	notify(ctx, lines.join("\n"), "info");
}

/** Show or set config. */
function cmdConfig(rt: FileGraphRuntime, ctx: ExtensionCommandContext, args: string[]): void {
	if (args.length === 0) {
		notify(ctx, formatConfig(rt.configRef.current), "info");
		return;
	}
	const key = args[0]!;
	const jsonValue = args.slice(1).join(" ");
	if (jsonValue.length === 0) {
		notify(ctx, `Usage: /fg config <key> <json-value>  (or /fg config to view)`, "warning");
		return;
	}
	rt.configRef.current = setConfigKey(rt.configRef.current, key, jsonValue);
	const store = ensureStore(rt, ctx.cwd);
	if (store) saveConfig(store, rt.configRef.current);
	if (key === "profile" || key === "namespaces") resetStore(rt);
	notify(ctx, `File Graph: config "${key}" updated`, "info");
}

/** Export the glossary and graph to user-chosen paths. */
function cmdExport(rt: FileGraphRuntime, ctx: ExtensionCommandContext, args: string[]): void {
	if (args.length < 2) {
		notify(ctx, `Usage: /fg export <ubiquitous-language-path> <graph-path>`, "warning");
		return;
	}
	const store = ensureStore(rt, ctx.cwd);
	if (!store) return notify(ctx, "File Graph: could not open store", "error");
	const ulPath = resolve(ctx.cwd, args[0]!);
	const graphPath = resolve(ctx.cwd, args[1]!);
	writeFileSync(ulPath, generateUbiquitousLanguage(store));
	writeFileSync(graphPath, generateGraphExport(store));
	notify(ctx, `Exported: ${ulPath}, ${graphPath}`, "info");
}

/** Show a mermaid graph of the whole workspace. */
function cmdView(rt: FileGraphRuntime, ctx: ExtensionCommandContext): void {
	const store = ensureStore(rt, ctx.cwd);
	if (!store) return notify(ctx, "File Graph: could not open store", "error");
	const mermaid = generateMermaid(store, { type: "workspace" });
	notify(ctx, mermaid, "info");
}

/** Notify the user if the UI is available. */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}
