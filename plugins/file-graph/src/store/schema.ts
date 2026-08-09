/**
 * SQLite schema definition and FTS5 feature detection.
 *
 * Tables match spec §4 exactly. FTS5 is feature-detected at open time; when
 * unavailable, a plain LIKE-indexed table provides the same search surface.
 */

import type { Database } from "bun:sqlite";

/** Schema version, bumped when reparse of unchanged files is required. */
export const SCHEMA_VERSION = 2;

/** Core table DDL — identical regardless of FTS availability. */
const TABLE_DDL = [
	`CREATE TABLE IF NOT EXISTS files (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		path TEXT UNIQUE NOT NULL,
		mtime_ms INTEGER NOT NULL,
		content_hash TEXT NOT NULL,
		title TEXT,
		purpose TEXT,
		indexed_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS headings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		depth INTEGER NOT NULL,
		text TEXT NOT NULL,
		slug TEXT NOT NULL,
		parent_id INTEGER REFERENCES headings(id) ON DELETE SET NULL,
		start_line INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS entities (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT UNIQUE NOT NULL,
		namespace TEXT,
		definition TEXT,
		def_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
		first_seen INTEGER NOT NULL,
		last_seen INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS relations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		src_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		src_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
		dst_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
		dst_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
		type TEXT NOT NULL,
		verb_raw TEXT NOT NULL,
		confidence REAL NOT NULL,
		source_line INTEGER NOT NULL,
		origin TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS definition_sites (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		entity_name TEXT NOT NULL,
		line INTEGER NOT NULL,
		kind TEXT NOT NULL,
		seq INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** Secondary indexes for query performance. */
const INDEX_DDL = [
	"CREATE INDEX IF NOT EXISTS idx_headings_file ON headings(file_id)",
	"CREATE INDEX IF NOT EXISTS idx_relations_src_file ON relations(src_file_id)",
	"CREATE INDEX IF NOT EXISTS idx_relations_src_entity ON relations(src_entity_id)",
	"CREATE INDEX IF NOT EXISTS idx_relations_dst_entity ON relations(dst_entity_id)",
	"CREATE INDEX IF NOT EXISTS idx_defsites_file ON definition_sites(file_id)",
	"CREATE INDEX IF NOT EXISTS idx_defsites_entity ON definition_sites(entity_name)",
];

/** FTS5 virtual table for full-text search. */
const FTS_DDL =
	"CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(" +
	"text, file_id UNINDEXED, kind UNINDEXED, line UNINDEXED, " +
	"tokenize = 'porter unicode61')";

/** LIKE fallback table when FTS5 is unavailable. */
const PLAIN_DDL = `CREATE TABLE IF NOT EXISTS search_plain (
		rowid INTEGER PRIMARY KEY AUTOINCREMENT,
		text TEXT NOT NULL,
		file_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		line INTEGER
	)`;

const PLAIN_INDEX = "CREATE INDEX IF NOT EXISTS idx_search_plain_file ON search_plain(file_id)";

/** Create all tables and indexes; returns true when FTS5 is available. */
export function initSchema(db: Database): boolean {
	const hasFts = tryFts(db);
	db.exec("PRAGMA foreign_keys = ON");
	for (const ddl of TABLE_DDL) db.run(ddl);
	for (const ddl of INDEX_DDL) db.run(ddl);
	if (hasFts) {
		db.run(FTS_DDL);
	} else {
		db.run(PLAIN_DDL);
		db.run(PLAIN_INDEX);
	}
	return hasFts;
}

/** Attempt FTS5 creation; return false (and clean up) if unsupported. */
function tryFts(db: Database): boolean {
	try {
		db.run(
			"CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x, tokenize = 'porter unicode61')",
		);
		db.run("DROP TABLE IF EXISTS _fts_probe");
		return true;
	} catch {
		return false;
	}
}
