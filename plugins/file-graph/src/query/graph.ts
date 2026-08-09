/**
 * Mermaid graph generation and relation-context formatting.
 *
 * Produces ASCII-renderable `graph LR` blocks for `fg_relations` (view=mermaid)
 * and `/fg view` (workspace overview). Node count is capped with a truncation
 * note when the graph exceeds the limit.
 */

import type { EntityRow, RelationRow } from "../types";
import type { GraphStore } from "../store/store";

/** Default cap for the workspace-wide mermaid view. */
export const DEFAULT_VIEW_NODE_CAP = 50;

/** Scope for mermaid generation. */
export type MermaidScope =
	| { type: "workspace"; maxNodes?: number }
	| { type: "entity"; name: string }
	| { type: "file"; fileId: number };

/** Generate a mermaid `graph LR` block for the given scope. */
export function generateMermaid(store: GraphStore, scope: MermaidScope): string {
	const relations = collectRelations(store, scope);
	const entityNames = mapEntityNames(store.listEntities());
	const filePaths = mapFilePaths(store.listFiles());
	return renderMermaid(relations, entityNames, filePaths, scope);
}

/** Collect the relevant relation rows for a mermaid scope. */
function collectRelations(store: GraphStore, scope: MermaidScope): RelationRow[] {
	if (scope.type === "workspace") return store.allRelations();
	if (scope.type === "file") return store.getRelationsForFile(scope.fileId);
	const entity = store.getEntityByName(scope.name);
	return entity ? store.getRelationsForEntity(entity.id) : [];
}

/** Render relation rows as a mermaid graph string. */
function renderMermaid(
	relations: RelationRow[],
	entityNames: Map<number, string>,
	filePaths: Map<number, string>,
	scope: MermaidScope,
): string {
	const cap = scope.type === "workspace" ? (scope.maxNodes ?? DEFAULT_VIEW_NODE_CAP) : 9999;
	const lines: string[] = ["graph LR"];
	const nodeLabels = new Map<string, string>();
	const edges: string[] = [];

	for (const r of relations) {
		if (nodeLabels.size >= cap) break;
		addMermaidEdge(r, entityNames, filePaths, nodeLabels, edges, cap);
	}

	for (const [id, label] of nodeLabels) {
		lines.push(`  ${id}["${escapeMermaid(label)}"]`);
	}
	for (const edge of edges) {
		lines.push(`  ${edge}`);
	}
	if (nodeLabels.size >= cap) {
		lines.push(`  %% truncated at ${cap} nodes`);
	}
	return lines.join("\n");
}

/** Add one edge (and its endpoint nodes) to the mermaid output. */
function addMermaidEdge(
	r: RelationRow,
	entityNames: Map<number, string>,
	filePaths: Map<number, string>,
	nodeLabels: Map<string, string>,
	edges: string[],
	cap: number,
): void {
	const srcId = resolveNodeId(r, "src", entityNames, filePaths, nodeLabels, cap);
	const dstId = resolveNodeId(r, "dst", entityNames, filePaths, nodeLabels, cap);
	if (!srcId || !dstId) return;
	edges.push(`${srcId} -->|${escapeMermaid(r.type)}| ${dstId}`);
}

/** Resolve one endpoint to a mermaid node id, registering its label. */
function resolveNodeId(
	r: RelationRow,
	end: "src" | "dst",
	entityNames: Map<number, string>,
	filePaths: Map<number, string>,
	nodeLabels: Map<string, string>,
	cap: number,
): string | null {
	const entityId = end === "src" ? r.srcEntityId : r.dstEntityId;
	if (entityId !== null) {
		const name = entityNames.get(entityId);
		if (name) return registerNode(name, name, nodeLabels, cap);
	}
	if (end === "src") {
		const path = filePaths.get(r.srcFileId);
		if (path) return registerNode(`file_${r.srcFileId}`, path, nodeLabels, cap);
	}
	return null;
}

/** Register a node id+label if under the cap; return the id or null. */
function registerNode(
	id: string,
	label: string,
	nodeLabels: Map<string, string>,
	cap: number,
): string | null {
	if (nodeLabels.has(id)) return id;
	if (nodeLabels.size >= cap) return null;
	nodeLabels.set(id, label);
	return id;
}

/** Escape characters that break mermaid syntax. */
function escapeMermaid(text: string): string {
	return text.replace(/["[\]]/g, "").replace(/\n/g, " ");
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
