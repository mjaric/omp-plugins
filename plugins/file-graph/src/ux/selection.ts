/**
 * Selection ledger — the pending "reference material" bundle a user approves
 * via the alt-g flow (spec §8).
 *
 * The bundle is the single source of truth for the `context` injector: while a
 * bundle is pending, one tail-side custom message is appended per LLM call;
 * `turn_end` clears it after the turn that consumed it.
 *
 * Persistence uses `pi.appendEntry` (a `CustomEntry`, never sent to the LLM)
 * so the pending selection survives a reload and is rebuilt from the session
 * branch on lifecycle events (start/switch/branch/tree). Clears are recorded
 * as a tombstone entry so "last entry on the branch wins" stays consistent.
 */

/** Reverse-domain customType for selection ledger entries (NOT sent to LLM). */
export const SELECTION_ENTRY_TYPE = "com.mjaric.file-graph.selection";

/**
 * The user-approved reference bundle.
 *
 * `content` is the exact text the user pruned in the editor step (file
 * excerpts with `## path` source headers); `sources` are the workspace-relative
 * file paths it was drawn from, for attribution and re-filtering.
 */
export interface SelectionBundle {
	/** User-approved reference text (editor output). Empty = tombstone. */
	content: string;
	/** Workspace-relative file paths the content was drawn from. */
	sources: string[];
	/** The prompt that drove the suggestion flow. */
	prompt: string;
	/** Epoch milliseconds when the bundle was approved. */
	createdAt: number;
}

/** In-memory handle to the currently pending bundle (null = nothing pending). */
export interface SelectionLedger {
	bundle: SelectionBundle | null;
}

/** Minimal sink for durable entries (satisfied by `ExtensionAPI`). */
export interface EntrySink {
	appendEntry(customType: string, data?: unknown): void;
}

/** Structural subset of a session entry — enough to rebuild the ledger. */
export interface LedgerEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Create an empty ledger. */
export function createLedger(): SelectionLedger {
	return { bundle: null };
}

/** A tombstone bundle marks a cleared selection on the durable branch. */
const TOMBSTONE: SelectionBundle = {
	content: "",
	sources: [],
	prompt: "",
	createdAt: 0,
};

/** True when a bundle carries real (non-tombstone) content. */
export function isPending(bundle: SelectionBundle | null): bundle is SelectionBundle {
	return bundle !== null && bundle.content.length > 0;
}

/**
 * Store a pending bundle: set the in-memory handle and append a durable entry.
 */
export function persistSelection(
	sink: EntrySink,
	ledger: SelectionLedger,
	bundle: SelectionBundle,
): void {
	ledger.bundle = bundle;
	sink.appendEntry(SELECTION_ENTRY_TYPE, bundle);
}

/**
 * Clear the pending selection. Appends a tombstone only when a bundle was
 * actually pending, so no-op turns write nothing and rebuild stays consistent.
 */
export function clearSelection(sink: EntrySink, ledger: SelectionLedger): void {
	if (ledger.bundle === null) return;
	ledger.bundle = null;
	sink.appendEntry(SELECTION_ENTRY_TYPE, TOMBSTONE);
}

/**
 * Rebuild the pending bundle from session branch entries (pure).
 *
 * Scans for ledger entries on the branch and keeps the last one; a tombstone
 * (empty content) yields `null`. This is the deterministic rebuild used on
 * session_start / switch / branch / tree.
 */
export function rebuildSelection(entries: readonly LedgerEntry[]): SelectionBundle | null {
	let last: SelectionBundle | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== SELECTION_ENTRY_TYPE) continue;
		last = readBundle(entry.data);
	}
	return isPending(last) ? last : null;
}

/** Coerce unknown entry data into a bundle (or null when malformed). */
function readBundle(data: unknown): SelectionBundle | null {
	if (!isBundleShape(data)) return null;
	return {
		content: data.content,
		sources: Array.isArray(data.sources) ? data.sources.filter(s => typeof s === "string") : [],
		prompt: typeof data.prompt === "string" ? data.prompt : "",
		createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
	};
}

/** Runtime structural check for a persisted bundle. */
function isBundleShape(data: unknown): data is SelectionBundle {
	if (typeof data !== "object" || data === null) return false;
	const candidate = data as { content?: unknown };
	return typeof candidate.content === "string";
}
