/**
 * fg_outline — heading outline of one file, or whole-workspace file→purpose map.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { HeadingRow } from "../types";
import type { GraphStore } from "../store/store";
import type { FileGraphRuntime } from "./shared";
import { ensureStore, errorResult, notInitialisedResult, textResult } from "./shared";

/** Register the fg_outline tool. */
export function registerOutlineTool(pi: ExtensionAPI, rt: FileGraphRuntime): void {
	const T = pi.typebox.Type;
	const params = T.Object({
		file: T.Optional(T.String({ description: "specific file path; omit for whole-workspace outline" })),
	});

	pi.registerTool({
		name: "fg_outline",
		label: "File Graph Outline",
		description:
			"Get the heading outline of a single file (with line numbers) or the whole workspace (file → purpose map).",
		parameters: params,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			if (p.file) return outlineOneFile(store, p.file);
			return outlineWorkspace(store);
		},
	});
}

/** Build the outline result for a single file. */
function outlineOneFile(store: GraphStore, file: string) {
	const fileRow = store.getFileByPath(file);
	if (!fileRow) return errorResult(`File not in graph: ${file}`, { error: "file_not_found", file });
	const headings = store.listHeadings(fileRow.id);
	return textResult(`${file}\n${formatHeadingTree(headings)}`, { file, outline: headings });
}

/** Build the whole-workspace file→purpose outline. */
function outlineWorkspace(store: GraphStore) {
	const files = store.listFiles();
	const lines = files.map(f => {
		const purpose = f.purpose ?? "(no purpose)";
		const title = f.title ? `${f.title} — ` : "";
		return `${f.path}: ${title}${purpose}`;
	});
	return textResult(lines.join("\n") || "No files indexed.", { files });
}

/** Render headings as an indented tree using their depth. */
function formatHeadingTree(headings: HeadingRow[]): string {
	return headings
		.map(h => `${"  ".repeat(h.depth - 1)}${"#".repeat(h.depth)} ${h.text} (L${h.startLine})`)
		.join("\n");
}
