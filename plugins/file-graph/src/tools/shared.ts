/**
 * Shared runtime state and helpers for tools and commands.
 *
 * The store is opened lazily on first use (by the reindex timer or a tool)
 * and cached per cwd. Best-effort: any open failure returns null, and tools
 * surface a "not initialised" error to the model.
 */

import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { FileGraphConfig } from "../types";
import { GraphStore } from "../store/store";
import type { Reranker } from "../query/rerank";
import { NOOP_RERANKER } from "../query/rerank";
import { resolveProfile } from "../profiles/profiles";
import { loadConfig, saveConfig } from "../config/config";

/** Mutable runtime shared across all tools and the /fg command. */
export interface FileGraphRuntime {
	storeRef: { current: GraphStore | null };
	cwdRef: { current: string | null };
	configRef: { current: FileGraphConfig };
	reranker: Reranker;
}

/** Create the initial runtime (store unopened, rerank disabled). */
export function createRuntime(): FileGraphRuntime {
	return {
		storeRef: { current: null },
		cwdRef: { current: null },
		configRef: { current: loadConfigFromDefaults() },
		reranker: NOOP_RERANKER,
	};
}

/** Ensure the store is open for the given cwd; returns null on failure. */
export function ensureStore(rt: FileGraphRuntime, cwd: string): GraphStore | null {
	if (rt.storeRef.current && rt.cwdRef.current === cwd) return rt.storeRef.current;
	const profile = resolveProfile(rt.configRef.current.profile, rt.configRef.current.namespaces);
	try {
		const store = GraphStore.open(cwd, profile);
		rt.storeRef.current = store;
		rt.cwdRef.current = cwd;
		rt.configRef.current = loadConfig(store);
		return store;
	} catch {
		return null;
	}
}

/** Close and clear the store so the next access reopens with a fresh profile. */
export function resetStore(rt: FileGraphRuntime): void {
	rt.storeRef.current?.close();
	rt.storeRef.current = null;
	rt.cwdRef.current = null;
}

/** Persist the current config to the store (if open). */
export function persistConfig(rt: FileGraphRuntime): void {
	if (rt.storeRef.current) saveConfig(rt.storeRef.current, rt.configRef.current);
}

/** Tool result for a "not initialised" state. */
export function notInitialisedResult(): AgentToolResult<{ error: string }> {
	return {
		content: [
			{
				type: "text",
				text: "File Graph index is not initialised. Run /fg reindex in an omp session to build the graph.",
			},
		],
		details: { error: "not_initialised" },
		isError: true,
	};
}

/** Build a text success result with structured details. */
export function textResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details };
}

/** Build a text error result with structured details. */
export function errorResult(message: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text: message }], details, isError: true };
}

/** Load config purely from defaults (no store yet). */
function loadConfigFromDefaults(): FileGraphConfig {
	return {
		profile: "generic",
		namespaces: [],
		rerankEnabled: false,
		rerankTopN: 12,
		endpoints: [],
	};
}

/** Type alias for the extension API (re-exported for tool modules). */
export type { ExtensionAPI };
