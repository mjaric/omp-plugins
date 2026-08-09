/**
 * fg_stats — graph statistics, dangling refs, missing-purpose, store path.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { FileGraphRuntime } from "./shared";
import { ensureStore, notInitialisedResult, textResult } from "./shared";

/** Register the fg_stats tool. */
export function registerStatsTool(pi: ExtensionAPI, rt: FileGraphRuntime): void {
	const T = pi.typebox.Type;
	const params = T.Object({});

	pi.registerTool({
		name: "fg_stats",
		label: "File Graph Stats",
		description:
			"Show graph statistics: file/entity/relation counts, dangling entity references, files missing purpose frontmatter, last reindex time, and store path.",
		parameters: params,
		async execute(_id, _p, _signal, _onUpdate, ctx) {
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			const files = store.listFiles();
			const entities = store.listEntities();
			const relations = store.allRelations();
			const dangling = entities.filter(e => e.defFileId === null).map(e => e.name);
			const missingPurpose = files.filter(f => f.purpose === null).map(f => f.path);
			const lastReindex = files.length > 0 ? Math.max(...files.map(f => f.indexedAt)) : null;
			return textResult(
				formatStats(files.length, entities.length, relations.length, dangling, missingPurpose, lastReindex, store.path, store.ftsEnabled),
				{
					files: files.length,
					entities: entities.length,
					relations: relations.length,
					dangling,
					missingPurpose,
					lastReindex,
					storePath: store.path,
					fts: store.ftsEnabled,
				},
			);
		},
	});
}

/** Format the stats block for the model. */
function formatStats(
	files: number,
	entities: number,
	relations: number,
	dangling: string[],
	missingPurpose: string[],
	lastReindex: number | null,
	storePath: string,
	fts: boolean,
): string {
	const lines = [
		`files: ${files}`,
		`entities: ${entities}`,
		`relations: ${relations}`,
		`dangling refs: ${dangling.length}${dangling.length > 0 ? ` (${dangling.join(", ")})` : ""}`,
		`missing purpose: ${missingPurpose.length}${missingPurpose.length > 0 ? ` (${missingPurpose.join(", ")})` : ""}`,
		`last reindex: ${lastReindex ? new Date(lastReindex).toISOString() : "never"}`,
		`search: ${fts ? "FTS5" : "LIKE"}`,
		`store: ${storePath}`,
	];
	return lines.join("\n");
}
