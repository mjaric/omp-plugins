/**
 * Export generators — produce the content for `UBIQUITOUS-LANGUAGE.md`
 * (entity glossary) and `GRAPH.md` (typed edge list) that `fg_export`
 * writes to user-chosen paths.
 */

import type { EntityRow } from "../types";
import type { GraphStore } from "../store/store";

/** Generate the ubiquitous-language glossary as markdown. */
export function generateUbiquitousLanguage(store: GraphStore): string {
	const entities = store.listEntities();
	const filePaths = mapFilePaths(store.listFiles());
	const lines: string[] = ["# Ubiquitous Language", "", "Terms defined across the workspace graph.", ""];
	if (entities.length === 0) {
		lines.push("_No entities indexed yet. Run `/fg reindex` to build the graph._");
		return lines.join("\n");
	}
	lines.push("| Entity | Namespace | Definition | Defined In |");
	lines.push("|---|---|---|---|");
	for (const e of entities) {
		lines.push(`| ${e.name} | ${e.namespace ?? "—"} | ${e.definition ?? "—"} | ${defPath(e, filePaths)} |`);
	}
	return lines.join("\n");
}

/** Generate the typed edge list as markdown. */
export function generateGraphExport(store: GraphStore): string {
	const entityNames = mapEntityNames(store.listEntities());
	const filePaths = mapFilePaths(store.listFiles());
	const relations = store.allRelations();
	const lines: string[] = ["# Knowledge Graph", "", "Typed cross-file relations extracted from the workspace.", ""];
	if (relations.length === 0) {
		lines.push("_No relations indexed yet._");
		return lines.join("\n");
	}
	lines.push("| Source | Relation | Target | Declared In |");
	lines.push("|---|---|---|---|");
	for (const r of relations) {
		const src = resolveSourceLabel(r, entityNames, filePaths);
		const dst = resolveTargetLabel(r, entityNames);
		const declared = filePaths.get(r.srcFileId) ?? "?";
		lines.push(`| ${src} | ${r.type} | ${dst} | ${declared} |`);
	}
	return lines.join("\n");
}

/** Resolve the definition-file path for an entity row. */
function defPath(entity: EntityRow, filePaths: Map<number, string>): string {
	return entity.defFileId !== null ? filePaths.get(entity.defFileId) ?? "—" : "—";
}

/** Resolve the source label (entity name or file path). */
function resolveSourceLabel(
	r: { srcEntityId: number | null; srcFileId: number },
	entityNames: Map<number, string>,
	filePaths: Map<number, string>,
): string {
	if (r.srcEntityId !== null) {
		const name = entityNames.get(r.srcEntityId);
		if (name) return name;
	}
	return filePaths.get(r.srcFileId) ?? "?";
}

/** Resolve the target label (entity name or "?"). */
function resolveTargetLabel(
	r: { dstEntityId: number | null },
	entityNames: Map<number, string>,
): string {
	if (r.dstEntityId === null) return "?";
	return entityNames.get(r.dstEntityId) ?? "?";
}

/** Build an entity-id → name map. */
function mapEntityNames(entities: EntityRow[]): Map<number, string> {
	const map = new Map<number, string>();
	for (const e of entities) map.set(e.id, e.name);
	return map;
}

/** Build a file-id → path map. */
function mapFilePaths(files: { id: number; path: string }[]): Map<number, string> {
	const map = new Map<number, string>();
	for (const f of files) map.set(f.id, f.path);
	return map;
}
