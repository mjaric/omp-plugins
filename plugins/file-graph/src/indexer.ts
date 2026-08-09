/**
 * Incremental reindex orchestrator.
 *
 * Walks the workspace for `*.md`, parses only files whose mtime or content
 * hash has changed, and runs the entity resolution pass once at the end.
 * Re-running reindex on an unchanged workspace is a no-op (idempotent).
 */

import { join } from "node:path";
import type { Profile } from "./types";
import type { GraphStore } from "./store/store";
import { contentHash, findMarkdownFiles, mtimeMs, readText } from "./workspace";
import { parseMarkdown } from "./parser/parse";

/** Outcome of a reindex pass. */
export interface ReindexResult {
	added: number;
	updated: number;
	unchanged: number;
	deleted: number;
	durationMs: number;
}

/**
 * Reindex all markdown files in a workspace into the store.
 * Synchronous — all I/O (fs reads, SQLite) is blocking under Bun.
 */
export function reindex(store: GraphStore, workspaceAbsPath: string, profile: Profile): ReindexResult {
	const start = Date.now();
	const mdFiles = findMarkdownFiles(workspaceAbsPath);
	const current = new Set(mdFiles);
	const force = store.needsReparse();

	let added = 0;
	let updated = 0;
	let unchanged = 0;

	for (const relPath of mdFiles) {
		const outcome = reindexOne(store, workspaceAbsPath, relPath, profile, force);
		if (outcome === "added") added++;
		else if (outcome === "updated") updated++;
		else unchanged++;
	}

	const deleted = pruneDeleted(store, current);
	if (force) store.clearReparseFlag();

	store.resolveDefinitionSites();

	return { added, updated, unchanged, deleted, durationMs: Date.now() - start };
}

/** Reindex a single file; returns its change classification. */
function reindexOne(
	store: GraphStore,
	workspaceAbsPath: string,
	relPath: string,
	profile: Profile,
	force: boolean,
): "added" | "updated" | "unchanged" {
	const absPath = join(workspaceAbsPath, relPath);
	const existing = store.getFileByPath(relPath);
	const currentMtime = safeMtime(absPath);
	if (currentMtime === null) return "unchanged";

	if (existing && existing.mtimeMs === currentMtime && !force) return "unchanged";

	const content = readText(absPath);
	const hash = contentHash(content);
	if (existing && existing.contentHash === hash && !force) return "unchanged";

	const parsed = parseMarkdown(content, relPath, profile);
	store.upsertFile({ parsed, mtimeMs: currentMtime, contentHash: hash });
	return existing ? "updated" : "added";
}

/** Delete store rows for files that no longer exist in the workspace. */
function pruneDeleted(store: GraphStore, currentPaths: Set<string>): number {
	let deleted = 0;
	for (const file of store.listFiles()) {
		if (!currentPaths.has(file.path)) {
			store.deleteFile(file.path);
			deleted++;
		}
	}
	return deleted;
}

/** Return mtime in ms, or null if the file is inaccessible. */
function safeMtime(absPath: string): number | null {
	try {
		return mtimeMs(absPath);
	} catch {
		return null;
	}
}
