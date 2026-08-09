/**
 * file-graph extension factory.
 *
 * Registers all fg_* tools and the /fg command at load time. On session_start,
 * schedules an initial incremental reindex via a managed timer. Best-effort:
 * any init failure logs and leaves tools returning "not initialised" — the
 * session keeps working.
 *
 * Wave 2 adds the interactive UX layer (spec §8): a silent suggestion widget
 * on `input`, an `alt+g` review flow, a `context` handler that injects the
 * user-approved reference bundle tail-side (prefix stays byte-identical), and
 * a `turn_end` clear. All UI paths are guarded by `ctx.hasUI`; headless modes
 * keep the `fg_suggest` tool as the agent path.
 *
 * Gate-0 decision: hand-rolled line-oriented parser (web-tree-sitter fails to
 * initialise under Bun and needs a network-fetched grammar; see README §Gate 0).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createRuntime, ensureStore, type FileGraphRuntime } from "./tools/shared";
import { reindex } from "./indexer";
import { resolveProfile } from "./profiles/profiles";
import { registerFgCommand } from "./commands/fg-command";
import {
	clearSelection,
	createLedger,
	rebuildSelection,
	type LedgerEntry,
	type SelectionLedger,
} from "./ux/selection";
import { createContextHandler } from "./ux/inject";
import { createInputHandler, createSelectionShortcut, SELECTION_SHORTCUT } from "./ux/flow";
import { registerOutlineTool } from "./tools/outline";
import { registerSearchTool } from "./tools/search";
import { registerRelationsTool } from "./tools/relations";
import { registerSuggestTool } from "./tools/suggest";
import { registerExportTool } from "./tools/export";
import { registerStatsTool } from "./tools/stats";

/** Delay before the initial reindex runs (lets the session settle). */
const INITIAL_REINDEX_DELAY_MS = 500;

export default function fileGraph(pi: ExtensionAPI): void {
	pi.setLabel("File Graph");
	const rt = createRuntime();
	const ledger = createLedger();
	const rebuildLedger = (entries: readonly LedgerEntry[]): void => {
		ledger.bundle = rebuildSelection(entries);
	};

	registerSearchTool(pi, rt);
	registerOutlineTool(pi, rt);
	registerRelationsTool(pi, rt);
	registerSuggestTool(pi, rt);
	registerExportTool(pi, rt);
	registerStatsTool(pi, rt);
	registerFgCommand(pi, rt);
	registerUxLayer(pi, rt, ledger);

	pi.on("session_start", (_event, ctx) => {
		rebuildLedger(ctx.sessionManager.getBranch());
		ctx.setTimeout(() => {
			scheduleReindex(pi, rt, ctx.cwd);
		}, INITIAL_REINDEX_DELAY_MS);
	});
	pi.on("session_switch", (_event, ctx) => rebuildLedger(ctx.sessionManager.getBranch()));
	pi.on("session_branch", (_event, ctx) => rebuildLedger(ctx.sessionManager.getBranch()));
	pi.on("session_tree", (_event, ctx) => rebuildLedger(ctx.sessionManager.getBranch()));
	pi.on("turn_end", () => clearSelection(pi, ledger));
}

/** Best-effort initial reindex: logs on failure, never throws. */
function scheduleReindex(pi: ExtensionAPI, rt: ReturnType<typeof createRuntime>, cwd: string): void {
	try {
		const store = ensureStore(rt, cwd);
		if (!store) {
			pi.logger.error("file-graph: could not open store — tools will report 'not initialised'");
			return;
		}
		const profile = resolveProfile(rt.configRef.current.profile, rt.configRef.current.namespaces);
		const result = reindex(store, cwd, profile);
		pi.logger.info(
			`file-graph: indexed ${result.added + result.updated} files (${result.added} new, ${result.updated} updated) in ${result.durationMs}ms`,
		);
	} catch (err) {
		pi.logger.error(`file-graph: reindex failed — ${(err as Error).message}`);
	}
}

/**
 * Register the interactive UX layer (spec §8) behind a best-effort guard.
 *
 * Registration never throws; handler bodies catch and degrade so a UX failure
 * can never break the session. The `context` injector appends only while a
 * selection is pending (see {@link createContextHandler}).
 */
function registerUxLayer(
	pi: ExtensionAPI,
	rt: FileGraphRuntime,
	ledger: SelectionLedger,
): void {
	pi.on("context", createContextHandler(ledger));
	pi.on("input", createInputHandler(rt));
	pi.registerShortcut(SELECTION_SHORTCUT, {
		description: "file-graph: review relevant, not-in-context references and inject as reference",
		handler: createSelectionShortcut(pi, rt, ledger),
	});
}
