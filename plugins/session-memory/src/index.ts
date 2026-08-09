/**
 * session-memory extension factory (spec §6, §7, §8).
 *
 * Registers the smem_* tools and the /smem command at load time, then wires the
 * lifecycle handlers: message_end → chunk+embed+upsert; input → build recall;
 * context → append one recall message at the tail; turn_end → ledger + telemetry;
 * compaction → mark chunks; session_shutdown → bounded drain. All work is
 * best-effort: a handler never throws into the session.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createRuntime } from "./runtime";
import {
	type SmemRuntime,
	branchMessages,
	buildQueryText,
	drainWithBudget,
	ensureStore,
	prepareRecall,
	trackWrite,
} from "./runtime";
import { chunkMessage, estimateTokens, extractMessageText } from "./chunk";
import { encodeVector } from "./vector";
import { textHash, telemetryPath } from "./workspace";
import { LEDGER_TYPE, applyContextInjection, rebuildLedger } from "./inject";
import type { MemStore } from "./store/store";
import type { ChunkInput, IndexedRole } from "./types";
import { appendTelemetryRow, buildTelemetryRow, readUsage } from "./telemetry";
import { registerRecallTool } from "./tools/recall";
import { registerStatsTool } from "./tools/stats";
import { registerStatusTool } from "./tools/status";
import { registerSmemCommand } from "./commands/smem-command";

/** Defer before indexing a message (lets the session settle). */
const INDEX_DEFER_MS = 50;
/** Max concurrent embed+upsert workers per message. */
const INDEX_CONCURRENCY = 4;
/** Shutdown drain budget (spec §6.4). */
const SHUTDOWN_BUDGET_MS = 2000;

export default function sessionMemory(pi: ExtensionAPI): void {
	pi.setLabel("Session Memory");
	const rt = createRuntime();
	const turnRef = { current: 0 };

	registerRecallTool(pi, rt);
	registerStatsTool(pi, rt);
	registerStatusTool(pi, rt);
	registerSmemCommand(pi, rt);

	pi.on("session_start", (_event, ctx) => onSessionStart(pi, rt, ctx));
	pi.on("session_switch", (_event, ctx) => rebuildLedgerInto(pi, rt, ctx));
	pi.on("session_branch", (_event, ctx) => rebuildLedgerInto(pi, rt, ctx));
	pi.on("session_tree", (_event, ctx) => rebuildLedgerInto(pi, rt, ctx));
	pi.on("turn_start", event => {
		turnRef.current = event.turnIndex;
	});
	pi.on("message_end", (event, ctx) => {
		onMessageEnd(pi, rt, ctx, event.message, turnRef.current);
	});
	pi.on("input", (event, ctx) => {
		void onInput(pi, rt, ctx, event.text);
	});
	pi.on("context", event => {
		const injected = applyContextInjection(event.messages, rt.inject);
		return injected ? { messages: injected } : undefined;
	});
	pi.on("turn_end", (event, ctx) => onTurnEnd(pi, rt, ctx, event.turnIndex));
	pi.on("session_compact", (_event, ctx) => onCompact(pi, rt, ctx));
	pi.on("auto_compaction_end", (_event, ctx) => onCompact(pi, rt, ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		void onShutdown(pi, rt, ctx);
	});
}

function onSessionStart(pi: ExtensionAPI, rt: SmemRuntime, ctx: ExtensionContext): void {
	ensureStore(rt, ctx.cwd);
	rebuildLedgerInto(pi, rt, ctx);
}

function rebuildLedgerInto(pi: ExtensionAPI, rt: SmemRuntime, ctx: ExtensionContext): void {
	try {
		rt.inject.injectedLedger = rebuildLedger(ctx.sessionManager.getBranch());
		rt.sessionIdRef.current = ctx.sessionManager.getSessionId() ?? null;
	} catch (err) {
		pi.logger.error(`session-memory: ledger rebuild failed — ${(err as Error).message}`);
	}
}

function onMessageEnd(
	pi: ExtensionAPI,
	rt: SmemRuntime,
	ctx: ExtensionContext,
	message: unknown,
	turnNo: number,
): void {
	try {
		const extracted = extractMessageText(message);
		if (!extracted) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		const store = ensureStore(rt, ctx.cwd);
		if (!store) return;
		scheduleIndexing(pi, rt, ctx, store, sessionId, extracted.role, extracted.text, turnNo);
	} catch (err) {
		pi.logger.error(`session-memory: message_end failed — ${(err as Error).message}`);
	}
}

function scheduleIndexing(
	pi: ExtensionAPI,
	rt: SmemRuntime,
	ctx: ExtensionContext,
	store: MemStore,
	sessionId: string,
	role: IndexedRole,
	text: string,
	turnNo: number,
): void {
	const chunks = chunkMessage(
		{ sessionId, role, turnNo, text, tokenEstimate: estimateTokens(text) },
		rt.configRef.current.maxChunkTokens,
	);
	if (chunks.length === 0) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	trackWrite(rt, promise);
	ctx.setTimeout(() => {
		void runIndexBounded(pi, store, rt.chainRef.current, chunks).finally(resolve);
	}, INDEX_DEFER_MS);
}

/** Index chunks with bounded concurrency; each failure logs and skips (§6.3). */
async function runIndexBounded(
	pi: ExtensionAPI,
	store: MemStore,
	chain: SmemRuntime["chainRef"]["current"],
	chunks: readonly ChunkInput[],
): Promise<void> {
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < chunks.length) {
			const chunk = chunks[cursor];
			cursor++;
			// Sequential await per worker is the bounded-concurrency design (workers
			// run in parallel via Promise.all below); Promise.all here would drop the cap.
			// eslint-disable-next-line no-await-in-loop
			if (chunk) await indexOne(pi, store, chain, chunk);
		}
	};
	const workerCount = Math.min(INDEX_CONCURRENCY, chunks.length);
	await Promise.all(Array.from({ length: workerCount }, worker));
}

async function indexOne(
	pi: ExtensionAPI,
	store: MemStore,
	chain: SmemRuntime["chainRef"]["current"],
	chunk: ChunkInput,
): Promise<void> {
	try {
		const hash = textHash(chunk.text);
		let embedding: Uint8Array | null = null;
		let model: string | null = null;
		if (chain) {
			const result = await chain.embed(chunk.text);
			if (result) {
				embedding = encodeVector(result.vector);
				model = result.model;
			}
		}
		store.upsertChunk(chunk, hash, embedding, model);
	} catch (err) {
		pi.logger.error(`session-memory: index chunk failed — ${(err as Error).message}`);
	}
}

async function onInput(pi: ExtensionAPI, rt: SmemRuntime, ctx: ExtensionContext, prompt: string): Promise<void> {
	if (rt.configRef.current.mode === "off") return;
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId || !ensureStore(rt, ctx.cwd)) return;
		const branch = ctx.sessionManager.getBranch();
		const queryText = buildQueryText(prompt, branch);
		rt.inject.pending = await prepareRecall(rt, sessionId, queryText, branchMessages(branch));
	} catch (err) {
		pi.logger.error(`session-memory: input recall failed — ${(err as Error).message}`);
	}
}

function onTurnEnd(pi: ExtensionAPI, rt: SmemRuntime, ctx: ExtensionContext, turnNo: number): void {
	try {
		const pkg = rt.inject.pending;
		writeTelemetry(pi, rt, ctx, turnNo, pkg);
		recordLedger(pi, rt, pkg);
	} catch (err) {
		pi.logger.error(`session-memory: turn_end failed — ${(err as Error).message}`);
	}
}

function writeTelemetry(pi: ExtensionAPI, rt: SmemRuntime, ctx: ExtensionContext, turnNo: number, pkg: import("./types").RecallPackage | null): void {
	const usage = readUsage(ctx.sessionManager.getBranch());
	const row = buildTelemetryRow(rt.configRef.current.mode, turnNo, usage, {
		injectedChunks: pkg?.injectedChunks ?? 0,
		injectedChars: pkg?.injectedChars ?? 0,
		dedupedChunks: pkg?.dedupedChunks ?? 0,
		recallMs: pkg?.recallMs ?? 0,
	});
	try {
		appendTelemetryRow(telemetryPath(ctx.cwd), row);
	} catch (err) {
		pi.logger.error(`session-memory: telemetry write failed — ${(err as Error).message}`);
	}
}

/** Record injected ids to the durable ledger once per turn, then clear pending. */
function recordLedger(pi: ExtensionAPI, rt: SmemRuntime, pkg: import("./types").RecallPackage | null): void {
	if (rt.inject.injectedThisTurn && pkg) {
		const ids = pkg.chunks.map(chunk => chunk.id);
		for (const id of ids) rt.inject.injectedLedger.add(id);
		pi.appendEntry(LEDGER_TYPE, { ids });
	}
	rt.inject.pending = null;
	rt.inject.injectedThisTurn = false;
}

function onCompact(pi: ExtensionAPI, rt: SmemRuntime, ctx: ExtensionContext): void {
	try {
		const store = ensureStore(rt, ctx.cwd);
		store?.markAllCompacted();
	} catch (err) {
		pi.logger.error(`session-memory: compaction mark failed — ${(err as Error).message}`);
	}
}

async function onShutdown(pi: ExtensionAPI, rt: SmemRuntime, ctx: ExtensionContext): Promise<void> {
	try {
		const result = await drainWithBudget([...rt.inFlight], SHUTDOWN_BUDGET_MS, managedSleep(ctx));
		pi.logger.info(`session-memory: drained ${result.completed}/${result.completed + result.pending} pending writes`);
	} catch (err) {
		pi.logger.error(`session-memory: shutdown drain failed — ${(err as Error).message}`);
	}
}

/** Build a sleep backed by the managed ctx timer (never a raw timer in a handler). */
function managedSleep(ctx: ExtensionContext): (ms: number) => Promise<void> {
	return (ms: number) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		ctx.setTimeout(() => resolve(), ms);
		return promise;
	};
}
