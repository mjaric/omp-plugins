/**
 * fg_relations — edges for a file or entity, with optional mermaid view.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { GraphStore } from "../store/store";
import type { FileGraphRuntime } from "./shared";
import { ensureStore, errorResult, notInitialisedResult, textResult } from "./shared";
import { generateMermaid } from "../query/graph";

/** Register the fg_relations tool. */
export function registerRelationsTool(pi: ExtensionAPI, rt: FileGraphRuntime): void {
	const T = pi.typebox.Type;
	const params = T.Object({
		entity: T.Optional(T.String({ description: "entity name (e.g. C4)" })),
		file: T.Optional(T.String({ description: "file path" })),
		view: T.Optional(T.Union([T.Literal("list"), T.Literal("mermaid")], { description: "output format (default list)" })),
	});

	pi.registerTool({
		name: "fg_relations",
		label: "File Graph Relations",
		description:
			"Get typed cross-file relations for an entity or file. Pass view=mermaid for an ASCII-renderable graph diagram.",
		parameters: params,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			if (!p.entity && !p.file) {
				return errorResult("Provide an entity or file parameter.", { error: "missing_scope" });
			}
			const wantMermaid = p.view === "mermaid";
			if (p.entity) return relationsForEntity(store, p.entity, wantMermaid);
			return relationsForFile(store, p.file!, wantMermaid);
		},
	});
}

/** Build relations result scoped to an entity. */
function relationsForEntity(store: GraphStore, name: string, mermaid: boolean) {
	const entity = store.getEntityByName(name);
	if (!entity) return errorResult(`Entity not found: ${name}`, { error: "entity_not_found", entity: name });
	if (mermaid) {
		const graph = generateMermaid(store, { type: "entity", name });
		return textResult(graph, { entity: name, view: "mermaid" });
	}
	const rels = store.getRelationsForEntity(entity.id);
	return textResult(formatRelations(rels, store), { entity: name, relations: rels });
}

/** Build relations result scoped to a file. */
function relationsForFile(store: GraphStore, file: string, mermaid: boolean) {
	const fileRow = store.getFileByPath(file);
	if (!fileRow) return errorResult(`File not in graph: ${file}`, { error: "file_not_found", file });
	if (mermaid) {
		const graph = generateMermaid(store, { type: "file", fileId: fileRow.id });
		return textResult(graph, { file, view: "mermaid" });
	}
	const rels = store.getRelationsForFile(fileRow.id);
	return textResult(formatRelations(rels, store), { file, relations: rels });
}

/** Format relation rows as a readable text block. */
function formatRelations(
	rels: { type: string; verbRaw: string; srcEntityId: number | null; dstEntityId: number | null; origin: string; sourceLine: number }[],
	store: GraphStore,
): string {
	if (rels.length === 0) return "No relations found.";
	return rels
		.map(r => {
			const src = entityLabel(store, r.srcEntityId) ?? "(file)";
			const dst = entityLabel(store, r.dstEntityId) ?? "?";
			return `${src} —[${r.type}]→ ${dst} (${r.origin} L${r.sourceLine})`;
		})
		.join("\n");
}

/** Resolve an entity id to its name, or null. */
function entityLabel(store: GraphStore, entityId: number | null): string | null {
	if (entityId === null) return null;
	const entities = store.listEntities();
	return entities.find(e => e.id === entityId)?.name ?? null;
}
