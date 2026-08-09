/**
 * Board table renderer — formats BoardState as a grouped table.
 *
 * Separated from the command handler so the rendering logic is testable
 * without ExtensionAPI. The renderer calls back via a minimal interface
 * instead of depending on ctx.ui directly.
 */

import type { BoardState } from "../github/board";

export interface BoardRenderer {
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	hasUI: boolean;
}

const STATUS_ORDER = ["Backlog", "Ready", "In progress", "In review", "Done"];

/** Group items by status, respecting STATUS_ORDER. */
function groupByStatus(items: BoardState["items"]): Record<string, typeof items> {
	const groups: Record<string, typeof items> = {};
	for (const item of items) {
		const status = item.status;
		if (groups[status] === undefined) {
			groups[status] = [];
		}
		groups[status].push(item);
	}
	return groups;
}

/** Format one row of the table. */
function formatRow(fields: string[], widths: number[]): string {
	return fields.map((f, i) => f.padEnd(widths[i] ?? 0)).join("  ");
}

/** Render the board as a text table, optionally filtered. */
export function renderBoard(state: BoardState, filter: string | undefined, renderer: BoardRenderer): void {
	const groups = groupByStatus(state.items);

	// Apply filter
	let statusKeys = [...STATUS_ORDER];
	if (filter !== undefined) {
		const lower = filter.toLowerCase();
		if (lower === "ready" || lower === "backlog" || lower === "in_progress" || lower === "in review" || lower === "done") {
			statusKeys = statusKeys.filter((s) => s.toLowerCase().replace(" ", "_") === lower || s.toLowerCase() === lower);
		} else if (lower.startsWith("slice-")) {
			// Filter by slice value instead of status
			statusKeys = STATUS_ORDER; // show all statuses, but only items in that slice
		}
	}

	const lines: string[] = ["", "Forge Board:", ""];

	// Column widths
	const colWidths = [10, 6, 50, 8];

	let hasAny = false;
	for (const status of statusKeys) {
		let items = groups[status] ?? [];

		// Slice filter
		if (filter !== undefined && filter.toLowerCase().startsWith("slice-")) {
			items = items.filter((i) => i.slice?.toLowerCase().replace(" ", "-") === filter?.toLowerCase());
		}

		if (items.length === 0) {
			continue;
		}
		hasAny = true;

		lines.push(`[${status}]`);
		for (const item of items) {
			const row = formatRow(
				[
					`#${item.issueNumber}`,
					`[${item.state}]`,
					item.title.length > 48 ? item.title.slice(0, 45) + "..." : item.title,
					item.slice ?? "—",
				],
				colWidths,
			);
			lines.push(`  ${row}`);
			if (item.milestone !== null) {
				lines.push(`         milestone: ${item.milestone}`);
			}
		}
		lines.push("");
	}

	if (!hasAny) {
		lines.push("(no items match the filter)");
		lines.push("");
	}

	const output = lines.join("\n");
	if (renderer.hasUI) {
		renderer.notify(output.trimEnd(), "info");
	}
}
