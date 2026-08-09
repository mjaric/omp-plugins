/**
 * Interactive UX flow (spec §8).
 *
 * Two entry points, both guarded by `ctx.hasUI` so headless/print/RPC/subagent
 * modes degrade to no-op (the `fg_suggest` tool remains the agent path):
 *
 * - `input` handler: silently computes candidates for the submitted prompt and
 *   surfaces a short `aboveEditor` widget listing the top relevant, not-in-
 *   context hits with an alt+g hint.
 * - `alt+g` shortcut: review flow — multi-select checklist (askDialog, with a
 *   single-select fallback loop), then an editor dialog pre-filled with the
 *   chosen excerpts for final pruning. The edited package is saved to the
 *   selection ledger and injected as reference material for the current turn.
 *
 * All dialog/UI calls are guarded; pure rendering helpers are exported for tests.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@oh-my-pi/pi-coding-agent";
import type { FileGraphRuntime } from "../tools/shared";
import { ensureStore } from "../tools/shared";
import { suggest } from "../query/search";
import {
	candidateFingerprint,
	filterInContext,
	messageFingerprints,
	toCandidates,
	type SuggestionCandidate,
} from "./candidates";
import {
	persistSelection,
	type EntrySink,
	type SelectionBundle,
	type SelectionLedger,
} from "./selection";

/** Widget key for the suggestion banner shown above the editor. */
export const WIDGET_KEY = "file-graph.suggestions";
/** Keyboard shortcut that opens the review flow (verified KeyId token). */
export const SELECTION_SHORTCUT = "alt+g" as const;

const CANDIDATE_LIMIT = 8;
const WIDGET_PREVIEW_COUNT = 4;
const EXCERPT_MAX_LINES = 12;
const DONE_LABEL = "Done";

/** Input event handler type (matches the `pi.on("input")` overload). */
export type InputHandler = (
	event: InputEvent,
	ctx: ExtensionContext,
) => Promise<InputEventResult | void> | InputEventResult | void;

/** Shortcut handler type (matches `pi.registerShortcut`). */
export type ShortcutHandler = (ctx: ExtensionContext) => Promise<void> | void;

/** Build the `input` handler that surfaces a silent suggestion widget. */
export function createInputHandler(rt: FileGraphRuntime): InputHandler {
	return async (event, ctx) => {
		if (!ctx.hasUI) return;
		await surfaceSuggestions(rt, ctx, event.text);
	};
}

/** Build the `alt+g` shortcut handler that runs the review flow. */
export function createSelectionShortcut(
	sink: EntrySink,
	rt: FileGraphRuntime,
	ledger: SelectionLedger,
): ShortcutHandler {
	return async ctx => {
		if (!ctx.hasUI) {
			ctx.ui.notify("file-graph: alt+g needs an interactive session");
			return;
		}
		const prompt = ctx.ui.getEditorText().trim();
		if (prompt.length === 0) {
			ctx.ui.notify("file-graph: type a prompt first, then press alt+g");
			return;
		}
		await runReviewFlow(sink, rt, ctx, ledger, prompt);
	};
}

/** Compute candidates and show/clear the suggestion widget. Best-effort. */
async function surfaceSuggestions(
	rt: FileGraphRuntime,
	ctx: ExtensionContext,
	prompt: string,
): Promise<void> {
	try {
		const candidates = await computeCandidates(rt, ctx, prompt);
		ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(candidates), { placement: "aboveEditor" });
	} catch {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

/** Run the full review flow and persist the user-approved package. */
async function runReviewFlow(
	sink: EntrySink,
	rt: FileGraphRuntime,
	ctx: ExtensionContext,
	ledger: SelectionLedger,
	prompt: string,
): Promise<void> {
	try {
		const candidates = await computeCandidates(rt, ctx, prompt);
		if (candidates.length === 0) {
			ctx.ui.notify("file-graph: no new candidates to suggest");
			return;
		}
		const selected = await pickCandidates(ctx.ui, candidates);
		if (selected.length === 0) {
			ctx.ui.notify("file-graph: nothing selected");
			return;
		}
		const edited = await ctx.ui.editor(
			"file-graph — review reference package (delete sections to prune)",
			renderPrefill(selected, readExcerpts(ctx.cwd, selected)),
		);
		if (edited === undefined || edited.trim().length === 0) {
			ctx.ui.notify("file-graph: cancelled");
			return;
		}
		persistSelection(sink, ledger, makeBundle(prompt, edited));
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.notify("file-graph: selection saved — injected as reference this turn");
	} catch (err) {
		ctx.ui.notify(`file-graph: suggestion flow failed — ${messageOf(err)}`, "error");
	}
}

/** Compute in-context-filtered candidates for a prompt. */
async function computeCandidates(
	rt: FileGraphRuntime,
	ctx: ExtensionContext,
	prompt: string,
): Promise<SuggestionCandidate[]> {
	const store = ensureStore(rt, ctx.cwd);
	if (!store) return [];
	const hits = await suggest(store, prompt, CANDIDATE_LIMIT);
	const candidates = toCandidates(hits);
	return filterInContext(candidates, buildFilterInputs(ctx.sessionManager.getBranch(), candidates));
}

/** Build the in-context filter inputs from the session branch and candidates. */
function buildFilterInputs(
	branch: readonly unknown[],
	candidates: readonly SuggestionCandidate[],
) {
	const branchText = serializeBranch(branch);
	const inContextPaths = new Set(
		candidates.filter(c => branchText.includes(c.path)).map(c => c.path),
	);
	return {
		inContextPaths,
		contentFingerprints: messageFingerprints(branchText.split("\n")),
	};
}

/** Best-effort serialisation of branch entries into a single text blob. */
function serializeBranch(branch: readonly unknown[]): string {
	return branch
		.map(entry => {
			try {
				return JSON.stringify(entry) ?? "";
			} catch {
				return "";
			}
		})
		.join("\n");
}

// -- multi-select candidate picker ----------------------------------------

/** Pick candidates via askDialog when available, else a single-select loop. */
async function pickCandidates(
	ui: ExtensionContext["ui"],
	candidates: readonly SuggestionCandidate[],
): Promise<SuggestionCandidate[]> {
	if (ui.askDialog) return pickViaAskDialog(ui, candidates);
	return pickViaSelectLoop(ui, candidates);
}

/** Rich multi-select checklist using the ask dialog. */
async function pickViaAskDialog(
	ui: ExtensionContext["ui"],
	candidates: readonly SuggestionCandidate[],
): Promise<SuggestionCandidate[]> {
	const options = candidates.map(c => ({ label: c.path, description: describeCandidate(c) }));
	const result = await ui.askDialog!([
		{ id: "fg", question: "Select reference candidates", header: "file-graph", options, multi: true },
	]);
	if (!result || result.kind !== "submit") return [];
	const selected = result.results[0]?.selectedOptions ?? [];
	const byPath = new Map(candidates.map(c => [c.path, c]));
	const picked = selected.map(label => byPath.get(label));
	return picked.filter((c): c is SuggestionCandidate => c !== undefined);
}

/** Fallback single-select loop for surfaces without askDialog. */
async function pickViaSelectLoop(
	ui: ExtensionContext["ui"],
	candidates: readonly SuggestionCandidate[],
): Promise<SuggestionCandidate[]> {
	const remaining = candidates.slice();
	const chosen: SuggestionCandidate[] = [];
	while (remaining.length > 0) {
		const options = [
			...remaining.map(c => ({ label: c.path, description: describeCandidate(c) })),
			{ label: DONE_LABEL, description: "finish selection" },
		];
		// Sequential by design: each dialog waits for the user's interactive pick.
		// eslint-disable-next-line no-await-in-loop
		const pick = await ui.select("file-graph: add a candidate", options);
		if (pick === undefined || pick === DONE_LABEL) break;
		const found = remaining.find(c => c.path === pick);
		if (!found) break;
		chosen.push(found);
		remaining.splice(remaining.indexOf(found), 1);
	}
	return chosen;
}

// -- pure rendering helpers (exported for tests) --------------------------

/** Render the widget banner lines, or `undefined` to clear the widget. */
export function buildWidgetLines(candidates: readonly SuggestionCandidate[]): string[] | undefined {
	if (candidates.length === 0) return undefined;
	const top = candidates.slice(0, WIDGET_PREVIEW_COUNT);
	const header = "file-graph: relevant, not in context";
	const items = top.map((c, i) => `  ${i + 1}. ${formatCandidateLabel(c)}`);
	return [header, ...items, `  (${SELECTION_SHORTCUT} to review and inject)`];
}

/** Render the editor prefill from selected candidates and their excerpts. */
export function renderPrefill(
	selected: readonly SuggestionCandidate[],
	excerpts: ReadonlyMap<string, string>,
): string {
	const lines: string[] = [];
	for (const candidate of selected) {
		const excerpt = excerpts.get(candidate.path) ?? fallbackExcerpt(candidate);
		lines.push(`## ${candidate.path}`);
		if (candidate.purpose) lines.push(`_${candidate.purpose}_`);
		else if (candidate.title) lines.push(`**${candidate.title}**`);
		if (excerpt.length > 0) lines.push(excerpt);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

/** Extract source paths (`## <path>` headers) from an edited package. */
export function extractSources(text: string): string[] {
	const sources: string[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^##\s+(\S+)/);
		if (match && match[1]) sources.push(match[1]);
	}
	return sources;
}

/** Build a selection bundle from the prompt and the edited package text. */
export function makeBundle(prompt: string, edited: string): SelectionBundle {
	return { content: edited, sources: extractSources(edited), prompt, createdAt: Date.now() };
}

/** Clip a file's content to a window around the first matched anchor line. */
export function clipExcerpt(content: string, startLine: number, maxLines: number): string {
	const lines = content.split("\n");
	const start = Math.max(0, Math.min(startLine, lines.length - 1));
	return lines.slice(start, start + Math.max(1, maxLines)).join("\n");
}

/** Fallback excerpt (anchors + purpose) when the file cannot be read. */
export function fallbackExcerpt(candidate: SuggestionCandidate): string {
	const anchors = candidate.anchors.map(a => a.text).filter(text => text.length > 0);
	if (anchors.length > 0) return anchors.join(" · ");
	return candidate.purpose ?? "";
}

// -- excerpt reading ------------------------------------------------------

/** Read a bounded excerpt for each selected candidate (best-effort). */
function readExcerpts(cwd: string, selected: readonly SuggestionCandidate[]): Map<string, string> {
	const excerpts = new Map<string, string>();
	for (const candidate of selected) {
		const content = readFileText(join(cwd, candidate.path));
		if (content === null) {
			excerpts.set(candidate.path, fallbackExcerpt(candidate));
			continue;
		}
		excerpts.set(candidate.path, clipExcerpt(content, firstAnchorLine(candidate), EXCERPT_MAX_LINES));
	}
	return excerpts;
}

/** Read a file as UTF-8 text, or null on any failure. */
function readFileText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** First anchor line number (0-based), or 0 when none is known. */
function firstAnchorLine(candidate: SuggestionCandidate): number {
	for (const anchor of candidate.anchors) {
		const line = (anchor as { line?: number }).line;
		if (typeof line === "number") return Math.max(0, line - 1);
	}
	return 0;
}

// -- small formatting helpers ---------------------------------------------

/** One-line label for a candidate in the widget banner. */
function formatCandidateLabel(candidate: SuggestionCandidate): string {
	return candidate.title ? `${candidate.path} — ${candidate.title}` : candidate.path;
}

/** Short description for a picker option. */
function describeCandidate(candidate: SuggestionCandidate): string {
	const head = candidate.title ?? candidate.path;
	return candidate.purpose ? `${head} — ${candidate.purpose}` : head;
}

/** Extract a usable message from an unknown caught error. */
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Re-exported so tests can construct dedupe sets without importing candidates.
export { candidateFingerprint };
