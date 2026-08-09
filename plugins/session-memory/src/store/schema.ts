/**
 * SQLite schema for the chunks table, plus FTS5 feature detection.
 *
 * `chunks` matches spec §4 exactly. FTS5 over chunk text is feature-detected at
 * open time; when unavailable, a LIKE-indexed table provides the same surface.
 * The primary retrieval path is cosine over vectors; FTS5 is a keyword fallback.
 */

import type { Database } from "bun:sqlite";

/** Schema version, bumped on incompatible changes. */
export const SCHEMA_VERSION = 1;

/** Core table DDL. The unique index enforces per-session text_hash dedup (§6.2). */
const TABLE_DDL = [
	`CREATE TABLE IF NOT EXISTS chunks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		role TEXT NOT NULL,
		turn_no INTEGER NOT NULL,
		text TEXT NOT NULL,
		text_hash TEXT NOT NULL,
		embedding BLOB,
		embedding_model TEXT,
		token_estimate INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		compacted INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_session_hash ON chunks(session_id, text_hash)`,
	`CREATE INDEX IF NOT EXISTS idx_chunks_model ON chunks(embedding_model) WHERE embedding_model IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS idx_chunks_turn ON chunks(session_id, turn_no)`,
	`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** FTS5 virtual table over chunk text (keyword fallback, not the ranking path). */
const FTS_DDL =
	"CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(" +
	"text, chunk_id UNINDEXED, tokenize = 'porter unicode61')";

/** LIKE fallback when FTS5 is unavailable. */
const PLAIN_DDL =
	"CREATE TABLE IF NOT EXISTS chunks_plain (chunk_id INTEGER, text TEXT)";
const PLAIN_INDEX = "CREATE INDEX IF NOT EXISTS idx_chunks_plain_text ON chunks_plain(text)";

/** Create all tables and indexes; returns true when FTS5 is available. */
export function initSchema(db: Database): boolean {
	db.exec(`PRAGMA journal_mode = WAL`);
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	for (const ddl of TABLE_DDL) db.exec(ddl);
	return tryFts(db);
}

/** Attempt FTS5 creation; on failure, fall back to the LIKE-indexed table. */
function tryFts(db: Database): boolean {
	try {
		db.exec(FTS_DDL);
		return true;
	} catch {
		db.exec(PLAIN_DDL);
		db.exec(PLAIN_INDEX);
		return false;
	}
}
