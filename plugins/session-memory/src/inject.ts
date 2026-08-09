/**
 * Injection state machine + the prefix-safe context-handler trick (spec §7).
 *
 * The `context` handler appends exactly ONE user message at the tail while a
 * recall package is pending, leaving the original prefix byte-identical. The
 * injection ledger (chunk ids already injected this session) is durable via
 * `pi.appendEntry("com.mjaric.session-memory.injected", …)` and rebuilt from
 * the session branch on start/switch/branch/tree.
 */

import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { RecallPackage } from "./types";
import { extractMessageText } from "./chunk";
import { textHash } from "./workspace";

/** Durable customType for the injection ledger entry. */
export const LEDGER_TYPE = "com.mjaric.session-memory.injected";

/** Mutable injection state shared across handlers. */
export interface InjectState {
	pending: RecallPackage | null;
	/** Chunk ids already injected this session (rebuilt from the durable ledger). */
	injectedLedger: Set<number>;
	/** True once the pending package was appended this turn (reset on turn_end). */
	injectedThisTurn: boolean;
}

/** Create empty injection state. */
export function createInjectState(): InjectState {
	return { pending: null, injectedLedger: new Set(), injectedThisTurn: false };
}


/** Rebuild the injected-id ledger from session branch custom entries. */
export function rebuildLedger(branch: readonly SessionEntry[]): Set<number> {
	const ids = new Set<number>();
	for (const entry of branch) {
		if (entry.type !== "custom") continue;
		const custom = entry as { customType?: unknown; data?: unknown };
		if (custom.customType !== LEDGER_TYPE) continue;
		collectIds(custom.data, ids);
	}
	return ids;
}

/** Compute the text hashes present in the current context messages (content-match dedup). */
export function contextHashes(messages: readonly unknown[]): Set<string> {
	const hashes = new Set<string>();
	for (const message of messages) {
		const extracted = extractMessageText(message);
		if (extracted) hashes.add(textHash(extracted.text));
	}
	return hashes;
}

/**
 * Append exactly one recall message to the tail while a non-empty package is
 * pending. Returns the new message array, or `undefined` to inject nothing.
 * The original prefix is returned untouched (byte-identical, spec §7.5).
 */
export function applyContextInjection<T>(
	messages: readonly T[],
	state: InjectState,
): T[] | undefined {
	const pkg = state.pending;
	if (pkg === null || pkg.mode === "off" || pkg.chunks.length === 0) return undefined;
	state.injectedThisTurn = true;
	const msg = buildInjectionMessage(pkg);
	return [...messages, msg as T];
}

/** Render the recall package as the injected context text. */
export function formatRecallMessage(pkg: RecallPackage): string {
	const lines: string[] = ["[session-memory recall — new context not already in your context]"];
	for (const chunk of pkg.chunks) {
		lines.push(`[turn ${chunk.turnNo}, ${chunk.role}]`);
		lines.push(chunk.text);
	}
	if (pkg.references.length > 0) {
		const refs = pkg.references.map(r => `[turn ${r.turnNo}, ${r.role}]`).join(", ");
		lines.push(`Already covered (not repeated): ${refs}`);
	}
	return lines.join("\n");
}

/** A minimal user-role message appended to the LLM context. */
export interface InjectableMessage {
	role: "user";
	content: string;
	timestamp: number;
}

/** Build the single appended user message from a recall package. */
export function buildInjectionMessage(pkg: RecallPackage): InjectableMessage {
	return { role: "user", content: formatRecallMessage(pkg), timestamp: Date.now() };
}

/** The chunk ids carried by the pending package (recorded into the ledger at turn_end). */
export function pendingInjectedIds(state: InjectState): number[] {
	if (state.pending === null) return [];
	return state.pending.chunks.map(chunk => chunk.id);
}

/** Collect numeric ids from a ledger entry's data payload. */
function collectIds(data: unknown, ids: Set<number>): void {
	if (typeof data !== "object" || data === null) return;
	const value = (data as { ids?: unknown }).ids;
	if (Array.isArray(value)) {
		for (const id of value) {
			if (typeof id === "number" && Number.isFinite(id)) ids.add(id);
		}
	}
}
