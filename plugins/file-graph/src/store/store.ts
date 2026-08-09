/**
 * GraphStore — durable persistence for the file knowledge graph.
 *
 * One SQLite database per workspace (spec §4), opened lazily and stored
 * OUTSIDE the project at `~/.omp/file-graph/<basename>-<hash>/graph.sqlite`.
 * Per-file replace is transactional: a changed file's headings, relations,
 * search docs, and definition sites are deleted and reinserted atomically.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
	EntityRow,
	FileRow,
	HeadingRow,
	ParsedFile,
	ParsedHeading,
	Profile,
	RelationRow,
	ResolveReport,
	SearchDoc,
} from "../types";
import { SCHEMA_VERSION, initSchema } from "./schema";
import { storePath } from "../workspace";

/** One ranked search-index row (FTS5 or LIKE fallback). */
export interface SearchIndexRow {
	fileId: number;
	kind: string;
	line: number | null;
	text: string;
	score: number;
}

/** Input for a transactional per-file replace. */
export interface FileUpsertInput {
	parsed: ParsedFile;
	mtimeMs: number;
	contentHash: string;
}

/** Reindex outcome for a single file. */
export type ReindexChange = "added" | "updated" | "unchanged";

export class GraphStore {
	private readonly db: Database;
	private readonly profile: Profile;
	private readonly hasFts: boolean;
	private readonly dbPath: string;

	private constructor(db: Database, profile: Profile, hasFts: boolean, dbPath: string) {
		this.db = db;
		this.profile = profile;
		this.hasFts = hasFts;
		this.dbPath = dbPath;
	}

	/** Open (or create) the store for a workspace path. */
	static open(workspaceAbsPath: string, profile: Profile): GraphStore {
		const dbPath = storePath(workspaceAbsPath);
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = new Database(dbPath, { create: true });
		db.exec("PRAGMA journal_mode = WAL");
		const hasFts = initSchema(db);
		const store = new GraphStore(db, profile, hasFts, dbPath);
		const previous = Number(store.getMeta("schema_version") ?? SCHEMA_VERSION);
		if (previous < SCHEMA_VERSION) store.setMeta("reparse_all", "1");
		store.setMeta("schema_version", String(SCHEMA_VERSION));
		store.setMeta("profile", profile.name);
		return store;
	}

	/** Underlying database file path. */
	get path(): string {
		return this.dbPath;
	}

	get ftsEnabled(): boolean {
		return this.hasFts;
	}

	close(): void {
		this.db.close();
	}

	// -- meta ---------------------------------------------------------------

	setMeta(key: string, value: string): void {
		this.db
			.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	getMeta(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
			| { value: string }
			| null;
		return row?.value ?? null;
	}

	/** True when a schema upgrade requires re-parsing unchanged files. */
	needsReparse(): boolean {
		return this.getMeta("reparse_all") === "1";
	}

	/** Clear the upgrade reparse flag after a full reindex pass. */
	clearReparseFlag(): void {
		this.db.prepare("DELETE FROM meta WHERE key = 'reparse_all'").run();
	}

	// -- files --------------------------------------------------------------

	/** Transactional per-file replace. Returns the file id. */
	upsertFile(input: FileUpsertInput): number {
		const now = Date.now();
		const tx = this.db.transaction(() => {
			const fileId = this.replaceFileRow(input.parsed, input.mtimeMs, input.contentHash, now);
			this.clearFileRows(fileId);
			this.insertHeadings(fileId, input.parsed.headings);
			this.insertDefinitionSites(fileId, input.parsed.definitionSites);
			this.insertRelations(fileId, input.parsed.relations);
			this.insertSearchDocs(fileId, input.parsed);
			return fileId;
		});
		return tx();
	}

	/** Insert or update the files row, returning its id. */
	private replaceFileRow(
		parsed: ParsedFile,
		mtimeMs: number,
		hash: string,
		now: number,
	): number {
		const row = this.db
			.prepare(
				`INSERT INTO files (path, mtime_ms, content_hash, title, purpose, indexed_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET
				   mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash,
				   title = excluded.title, purpose = excluded.purpose, indexed_at = excluded.indexed_at
				 RETURNING id`,
			)
			.get(parsed.path, mtimeMs, hash, parsed.title, parsed.frontmatter.purpose, now) as
			| { id: number }
			| null;
		return row?.id ?? 0;
	}

	/** Delete all per-file rows so the replace is clean. */
	private clearFileRows(fileId: number): void {
		this.db.prepare("DELETE FROM headings WHERE file_id = ?").run(fileId);
		this.db.prepare("DELETE FROM relations WHERE src_file_id = ?").run(fileId);
		this.db.prepare("DELETE FROM definition_sites WHERE file_id = ?").run(fileId);
		const table = this.hasFts ? "search_fts" : "search_plain";
		this.db.prepare(`DELETE FROM ${table} WHERE file_id = ?`).run(fileId);
	}

	/** Insert headings with parent-index → parent-id resolution. */
	private insertHeadings(fileId: number, headings: readonly ParsedHeading[]): void {
		const stmt = this.db.prepare(
			"INSERT INTO headings (file_id, depth, text, slug, parent_id, start_line) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const ids: number[] = [];
		for (let i = 0; i < headings.length; i++) {
			const h = headings[i]!;
			const parentId = h.parentIndex !== null ? (ids[h.parentIndex] ?? null) : null;
			const result = stmt.run(fileId, h.depth, h.text, h.slug, parentId, h.startLine);
			ids[i] = Number(result.lastInsertRowid);
		}
	}

	/** Insert definition-site candidates. */
	private insertDefinitionSites(
		fileId: number,
		sites: ParsedFile["definitionSites"],
	): void {
		const stmt = this.db.prepare(
			"INSERT INTO definition_sites (file_id, entity_name, line, kind, seq) VALUES (?, ?, ?, ?, ?)",
		);
		for (let i = 0; i < sites.length; i++) {
			const s = sites[i]!;
			stmt.run(fileId, s.name, s.line, s.kind, i);
		}
	}

	/** Insert relations, resolving entity names to ids. */
	private insertRelations(fileId: number, relations: ParsedFile["relations"]): void {
		const stmt = this.db.prepare(
			`INSERT INTO relations (src_file_id, src_entity_id, dst_file_id, dst_entity_id,
			   type, verb_raw, confidence, source_line, origin)
			 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
		);
		for (const rel of relations) {
			const srcId = rel.srcEntity ? this.getOrCreateEntity(rel.srcEntity) : null;
			const dstId = rel.dstEntity ? this.getOrCreateEntity(rel.dstEntity) : null;
			const confidence = rel.origin === "frontmatter" ? 1.0 : 0.5;
			stmt.run(fileId, srcId, dstId, rel.type, rel.verbRaw, confidence, rel.sourceLine, rel.origin);
		}
	}

	/** Upsert an entity by name, returning its id. */
	getOrCreateEntity(name: string): number {
		const now = Date.now();
		const row = this.db
			.prepare(
				`INSERT INTO entities (name, namespace, definition, def_file_id, first_seen, last_seen)
				 VALUES (?, ?, NULL, NULL, ?, ?)
				 ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen
				 RETURNING id`,
			)
			.get(name, deriveNamespace(name), now, now) as { id: number } | null;
		return row?.id ?? 0;
	}

	/** Insert search-index rows derived from the parsed file. */
	private insertSearchDocs(fileId: number, parsed: ParsedFile): void {
		const table = this.hasFts ? "search_fts" : "search_plain";
		const stmt = this.db.prepare(
			`INSERT INTO ${table} (text, file_id, kind, line) VALUES (?, ?, ?, ?)`,
		);
		for (const doc of deriveSearchDocs(fileId, parsed)) {
			stmt.run(doc.text, doc.fileId, doc.kind, doc.line);
		}
	}

	// -- queries ------------------------------------------------------------

	getFileByPath(path: string): FileRow | null {
		return (this.db
			.prepare(
				`SELECT id, path, mtime_ms AS mtimeMs, content_hash AS contentHash,
				        title, purpose, indexed_at AS indexedAt
				 FROM files WHERE path = ?`,
			)
			.get(path) as FileRow | null);
	}

	listFiles(): FileRow[] {
		return this.db
			.prepare(
				`SELECT id, path, mtime_ms AS mtimeMs, content_hash AS contentHash,
				        title, purpose, indexed_at AS indexedAt
				 FROM files ORDER BY path`,
			)
			.all() as FileRow[];
	}

	listHeadings(fileId: number): HeadingRow[] {
		return this.db
			.prepare(
				`SELECT id, ? AS fileId, depth, text, slug, parent_id AS parentId,
				        start_line AS startLine
				 FROM headings WHERE file_id = ? ORDER BY start_line`,
			)
			.all(fileId, fileId) as HeadingRow[];
	}

	getEntityByName(name: string): EntityRow | null {
		return (this.db
			.prepare(
				`SELECT id, name, namespace, definition, def_file_id AS defFileId,
				        first_seen AS firstSeen, last_seen AS lastSeen
				 FROM entities WHERE name = ?`,
			)
			.get(name) as EntityRow | null);
	}

	listEntities(): EntityRow[] {
		return this.db
			.prepare(
				`SELECT id, name, namespace, definition, def_file_id AS defFileId,
				        first_seen AS firstSeen, last_seen AS lastSeen
				 FROM entities ORDER BY name`,
			)
			.all() as EntityRow[];
	}

	getRelationsForFile(fileId: number): RelationRow[] {
		return this.db
			.prepare(
				`SELECT r.id, r.src_file_id AS srcFileId, r.src_entity_id AS srcEntityId,
				        r.dst_file_id AS dstFileId, r.dst_entity_id AS dstEntityId,
				        r.type, r.verb_raw AS verbRaw, r.confidence, r.source_line AS sourceLine,
				        r.origin
				 FROM relations r WHERE r.src_file_id = ? ORDER BY r.source_line`,
			)
			.all(fileId) as RelationRow[];
	}

	getRelationsForEntity(entityId: number): RelationRow[] {
		return this.db
			.prepare(
				`SELECT r.id, r.src_file_id AS srcFileId, r.src_entity_id AS srcEntityId,
				        r.dst_file_id AS dstFileId, r.dst_entity_id AS dstEntityId,
				        r.type, r.verb_raw AS verbRaw, r.confidence, r.source_line AS sourceLine,
				        r.origin
				 FROM relations r
				 WHERE r.src_entity_id = ? OR r.dst_entity_id = ?
				 ORDER BY r.confidence DESC`,
			)
			.all(entityId, entityId) as RelationRow[];
	}

	allRelations(): RelationRow[] {
		return this.db
			.prepare(
				`SELECT id, src_file_id AS srcFileId, src_entity_id AS srcEntityId,
				        dst_file_id AS dstFileId, dst_entity_id AS dstEntityId,
				        type, verb_raw AS verbRaw, confidence, source_line AS sourceLine, origin
				 FROM relations ORDER BY src_file_id, source_line`,
			)
			.all() as RelationRow[];
	}

	/** Full-text or LIKE search over the search index. */
	searchIndex(query: string, limit: number): SearchIndexRow[] {
		return this.hasFts ? this.searchFts(query, limit) : this.searchLike(query, limit);
	}

	private searchFts(query: string, limit: number): SearchIndexRow[] {
		const ftsQuery = sanitizeFtsQuery(query);
		if (ftsQuery.length === 0) return [];
		try {
			const rows = this.db
				.prepare(
					`SELECT file_id AS fileId, kind, line, text, bm25(search_fts) AS rank
					 FROM search_fts WHERE search_fts MATCH ?
					 ORDER BY rank ASC LIMIT ?`,
				)
				.all(ftsQuery, limit) as Array<{ fileId: number; kind: string; line: number | null; text: string; rank: number }>;
			return rows.map(r => ({ fileId: r.fileId, kind: r.kind, line: r.line, text: r.text, score: -r.rank }));
		} catch {
			return this.searchLike(query, limit);
		}
	}

	private searchLike(query: string, limit: number): SearchIndexRow[] {
		const terms = query.split(/\s+/).filter(t => t.length > 0);
		if (terms.length === 0) return [];
		const pattern = `%${query.trim()}%`;
		const rows = this.db
			.prepare("SELECT file_id AS fileId, kind, line, text FROM search_plain WHERE text LIKE ?")
			.all(pattern) as Array<{ fileId: number; kind: string; line: number | null; text: string }>;
		return rows
			.map(r => ({
				fileId: r.fileId,
				kind: r.kind,
				line: r.line,
				text: r.text,
				score: countTermMatches(r.text, terms),
			}))
			.filter(r => r.score > 0)
			.toSorted((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	// -- resolution ---------------------------------------------------------

	/** Pin def_file_id for each entity from definition-site candidates. */
	resolveDefinitionSites(): ResolveReport {
		this.db.run("UPDATE entities SET def_file_id = NULL");
		const sites = this.db
			.prepare(
				`SELECT ds.entity_name AS name, f.id AS fileId
				 FROM definition_sites ds
				 JOIN files f ON ds.file_id = f.id
				 ORDER BY f.path ASC, ds.seq ASC`,
			)
			.all() as Array<{ name: string; fileId: number }>;
		const update = this.db.prepare("UPDATE entities SET def_file_id = ? WHERE name = ?");
		const seen = new Set<string>();
		for (const s of sites) {
			if (seen.has(s.name)) continue;
			seen.add(s.name);
			update.run(s.fileId, s.name);
		}
		return this.buildResolveReport();
	}

	private buildResolveReport(): ResolveReport {
		const dangling = (this.db
			.prepare("SELECT name FROM entities WHERE def_file_id IS NULL ORDER BY name")
			.all() as Array<{ name: string }>).map(r => r.name);
		const missingPurpose = (this.db
			.prepare("SELECT path FROM files WHERE purpose IS NULL ORDER BY path")
			.all() as Array<{ path: string }>).map(r => r.path);
		const entityCount = (this.db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number }).n;
		return { dangling, missingPurpose, entityCount };
	}

	deleteFile(path: string): boolean {
		const result = this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
		return result.changes > 0;
	}
}

// -- pure helpers -----------------------------------------------------------

/** Derive search-index documents from a parsed file. */
function deriveSearchDocs(fileId: number, parsed: ParsedFile): SearchDoc[] {
	const docs: SearchDoc[] = [];
	if (parsed.title) {
		docs.push({ fileId, kind: "title", text: parsed.title, line: null });
	}
	if (parsed.frontmatter.purpose) {
		docs.push({ fileId, kind: "purpose", text: parsed.frontmatter.purpose, line: null });
	}
	for (const h of parsed.headings) {
		docs.push({ fileId, kind: "heading", text: h.text, line: h.startLine });
	}
	for (const name of parsed.entityRefs) {
		docs.push({ fileId, kind: "entity", text: name, line: null });
	}
	return docs;
}

/** Derive the bracket-namespace from an entity name (null for plain terms). */
function deriveNamespace(name: string): string | null {
	const match = name.match(/^([A-Za-z]{1,10})\d+(?:\.\d+)?$/);
	return match ? match[1]! : null;
}

/** Build an FTS5-safe prefix-OR query from free text. */
function sanitizeFtsQuery(query: string): string {
	const terms = query
		.split(/[\s,]+/)
		.map(t => t.replace(/[^A-Za-z0-9-]/g, ""))
		.filter(t => t.length > 0);
	if (terms.length === 0) return "";
	return terms.map(t => `${t}*`).join(" OR ");
}

/** Count how many query terms appear (case-insensitive) in the text. */
function countTermMatches(text: string, terms: readonly string[]): number {
	const lower = text.toLowerCase();
	let count = 0;
	for (const term of terms) {
		if (lower.includes(term.toLowerCase())) count++;
	}
	return count;
}
