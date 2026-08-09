/**
 * Shared runtime state + helpers for tools, commands, and event handlers.
 *
 * The store is opened lazily (by the first handler/tool) and cached per cwd.
 * Best-effort: any open failure returns null and tools surface a "not
 * initialised" error. The embedding chain is rebuilt whenever config changes.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG } from "./types";
import type { IndexedRole, RecallMode, RecallPackage, SmemConfig } from "./types";
import { MemStore } from "./store/store";
import { EmbeddingChain } from "./embedding";
import type { InjectState } from "./inject";
import { createInjectState, contextHashes } from "./inject";
import { loadConfig, saveConfig } from "./config";
import { buildRecallPackage } from "./recall";
import { extractMessageText } from "./chunk";

/** Mutable runtime shared across all handlers, tools, and the /smem command. */
export interface SmemRuntime {
	storeRef: { current: MemStore | null };
	cwdRef: { current: string | null };
	configRef: { current: SmemConfig };
	chainRef: { current: EmbeddingChain | null };
	inject: InjectState;
	sessionIdRef: { current: string | null };
	/** In-flight index writes, tracked for the shutdown drain (spec §6.4). */
	inFlight: Set<Promise<unknown>>;
}

/** Create the initial runtime (store unopened, defaults loaded). */
export function createRuntime(): SmemRuntime {
	return {
		storeRef: { current: null },
		cwdRef: { current: null },
		configRef: { current: { ...DEFAULT_CONFIG } },
		chainRef: { current: null },
		inject: createInjectState(),
		sessionIdRef: { current: null },
		inFlight: new Set(),
	};
}

/** Ensure the store is open for the given cwd; returns null on failure. */
export function ensureStore(rt: SmemRuntime, cwd: string): MemStore | null {
	if (rt.storeRef.current && rt.cwdRef.current === cwd) return rt.storeRef.current;
	try {
		const store = MemStore.open(cwd);
		rt.storeRef.current = store;
		rt.cwdRef.current = cwd;
		rt.configRef.current = loadConfig(store, process.env as Record<string, string | undefined>);
		rt.chainRef.current = rebuildChain(rt.configRef.current);
		return store;
	} catch {
		return null;
	}
}

/** Build a fresh embedding chain from the current config (default fetch + cooldown). */
export function rebuildChain(config: SmemConfig): EmbeddingChain {
	return new EmbeddingChain(config.endpoints, undefined, config.cooldownMs);
}

/** Persist config to the store and refresh the embedding chain. */
export function persistConfig(rt: SmemRuntime): void {
	if (!rt.storeRef.current) return;
	saveConfig(rt.storeRef.current, rt.configRef.current);
	rt.chainRef.current = rebuildChain(rt.configRef.current);
}

/** Track an in-flight write for the shutdown drain. */
export function trackWrite(rt: SmemRuntime, write: Promise<unknown>): void {
	rt.inFlight.add(write);
	void write.finally(() => {
		rt.inFlight.delete(write);
	});
}

/** Injected sleep used by {@link drainWithBudget} (overridable for fake-timer tests). */
export type DrainSleep = (ms: number) => Promise<void>;

/**
 * Await `tasks` until they settle or `budgetMs` elapses, whichever is first
 * (spec §6.4 shutdown drain). Returns how many settled vs. remain pending.
 */
export async function drainWithBudget(
	tasks: readonly Promise<unknown>[],
	budgetMs: number,
	sleep: DrainSleep = defaultSleep,
): Promise<{ completed: number; pending: number }> {
	if (tasks.length === 0) return { completed: 0, pending: 0 };
	let completed = 0;
	const counting = tasks.map(task => task.then(
		() => { completed++; },
		() => { completed++; },
	));
	await Promise.race([Promise.allSettled(counting), sleep(budgetMs)]);
	return { completed, pending: tasks.length - completed };
}

function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Build an empty (no-op) recall package for the given mode. */
export function emptyPackage(mode: RecallMode): RecallPackage {
	return {
		mode,
		references: [],
		chunks: [],
		injectedChunks: 0,
		injectedChars: 0,
		dedupedChunks: 0,
		recallMs: 0,
	};
}

/**
 * Run a recall pass against the current store/chain/config, deduping against the
 * supplied context messages. Returns an empty package when not initialised.
 */
export async function prepareRecall(
	rt: SmemRuntime,
	sessionId: string,
	queryText: string,
	contextMessages: readonly unknown[],
	signal?: AbortSignal,
): Promise<RecallPackage> {
	const store = rt.storeRef.current;
	const chain = rt.chainRef.current;
	if (store === null || chain === null) return emptyPackage(rt.configRef.current.mode);
	return buildRecallPackage(
		{
			store,
			chain,
			config: rt.configRef.current,
			sessionId,
			queryText,
			injectedLedger: rt.inject.injectedLedger,
			contextHashes: contextHashes(contextMessages),
		},
		signal,
	);
}

/** Number of recent user/assistant turns folded into a recall query (spec §7.1). */
const RECENT_QUERY_TURNS = 2;

/** Pull the message objects from a session branch. */
export function branchMessages(branch: readonly unknown[]): unknown[] {
	return branch.filter(isMessageEntry).map(entry => entry.message);
}

/** Build a recall query string from the prompt plus the last few turn texts. */
export function buildQueryText(prompt: string, branch: readonly unknown[]): string {
	const recent = branchMessages(branch)
		.map(message => extractMessageText(message))
		.filter((m): m is { role: IndexedRole; text: string } => m !== null)
		.slice(-RECENT_QUERY_TURNS)
		.map(m => m.text);
	return [prompt, ...recent].join("\n");
}

/** Type guard for a session message entry carrying a `.message`. */
function isMessageEntry(entry: unknown): entry is { type: "message"; message: unknown } {
	return typeof entry === "object"
		&& entry !== null
		&& (entry as { type?: unknown }).type === "message";
}

/** Tool result for a "not initialised" state. */
export function notInitialisedResult(): AgentToolResult<{ error: string }> {
	return {
		content: [
			{ type: "text", text: "Session Memory index is not initialised. Start an omp session in a workspace to build the index." },
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
