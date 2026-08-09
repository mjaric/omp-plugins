/**
 * fg_export — write UBIQUITOUS-LANGUAGE.md and GRAPH.md to user-chosen paths.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { FileGraphRuntime } from "./shared";
import { ensureStore, errorResult, notInitialisedResult, textResult } from "./shared";
import { generateGraphExport, generateUbiquitousLanguage } from "../query/export";

/** Register the fg_export tool. */
export function registerExportTool(pi: ExtensionAPI, rt: FileGraphRuntime): void {
	const T = pi.typebox.Type;
	const params = T.Object({
		ubiquitousLanguagePath: T.String({ description: "output path for UBIQUITOUS-LANGUAGE.md" }),
		graphPath: T.String({ description: "output path for GRAPH.md" }),
	});

	pi.registerTool({
		name: "fg_export",
		label: "File Graph Export",
		description:
			"Export the ubiquitous-language glossary (entities + definitions) and the typed edge list (GRAPH.md) to user-chosen file paths.",
		parameters: params,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			try {
				const ulPath = resolve(ctx.cwd, p.ubiquitousLanguagePath);
				const graphPath = resolve(ctx.cwd, p.graphPath);
				writeFileSync(ulPath, generateUbiquitousLanguage(store));
				writeFileSync(graphPath, generateGraphExport(store));
				return textResult(
					`Exported ubiquitous language to ${ulPath}\nExported graph to ${graphPath}`,
					{ ubiquitousLanguagePath: ulPath, graphPath },
				);
			} catch (e) {
				return errorResult(`Export failed: ${(e as Error).message}`, { error: "export_failed" });
			}
		},
	});
}
