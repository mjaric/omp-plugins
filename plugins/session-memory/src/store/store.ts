/**
 * MemStore — durable persistence for session chunks (spec §4).
 *
 * `bun:sqlite` holds the `chunks` table (with float32 embedding BLOBs and a
 * per-session text_hash uniqueness constraint for dedup). The store also owns
 * the `meta` table used for config persistence. Best-effort: `open` never
 * throws into a handler — failures are caught by the caller.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { ChunkInput, ChunkRow, IndexedRole } from "../types";
import { initSchema } from "./schema";
import { storePath } from "../workspace";
import { decodeVector } from "../vector";

/** Result of an upsert: the chunk id and whether a new row was inserted. */
export interface UpsertResult {
	id: number;
	inserted: boolean;
}

/** Open (or reopen) the store for a workspace; never throws into a handler. */
export class MemStore {
	/** Resolved database file path. */
	readonly path: string;
	private readonly db: Database;
	private closed = false;

	private constructor(path: string, db: Database) {
		this.path = path;
		this.db = db;
	}

	/** Create the store dir, open the database, and initialise the schema. */
	static open(absWorkspace: string): MemStore {
		const path = storePath(absWorkspace);
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path);
		db.exec("PRAGMA synchronous = NORMAL");
		initSchema(db);
		return new MemStore(path, db);
	}

	/** Close the database handle. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	/** Read a `meta` value by key. */
	getMeta(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
			| { value: string }
			| null;
		return row ? row.value : null;
	}

	/** Write a `meta` value (upsert). */
	setMeta(key: string, value: string): void {
		this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	/** Insert a chunk if its (session_id, text_hash) is new; returns the row id. */
	upsertChunk(input: ChunkInput, hash: string, embedding: Uint8Array | null, model: string | null): UpsertResult {
		const stmt = this.db.prepare(
			`INSERT OR IGNORE INTO chunks
			 (session_id, role, turn_no, text, text_hash, embedding, embedding_model, token_estimate, created_at, compacted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		);
		const res = stmt.run(
			input.sessionId,
			input.role,
			input.turnNo,
			input.text,
			hash,
			embedding,
			model,
			input.tokenEstimate,
			Date.now(),
		);
		const id = this.chunkIdByHash(input.sessionId, hash);
		return { id, inserted: res.changes === 1 };
	}

	/** Update an existing chunk's embedding + model (used by /smem rebuild). */
	updateEmbedding(id: number, embedding: Uint8Array, model: string): void {
		this.db.prepare("UPDATE chunks SET embedding = ?, embedding_model = ? WHERE id = ?").run(embedding, model, id);
	}

	/** Fetch a single chunk by id. */
	chunkById(id: number): ChunkRow | null {
		const row = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as ChunkDbRow | null;
		return row ? mapRow(row) : null;
	}

	/** All chunks for inspection/stats. */
	listChunks(): ChunkRow[] {
		const rows = this.db.prepare("SELECT * FROM chunks ORDER BY id").all() as ChunkDbRow[];
		return rows.map(mapRow);
	}

	/** Chunks whose embedding matches `model` (cross-model comparison forbidden, §5). */
	vectorCandidates(model: string): ChunkRow[] {
		const rows = this.db.prepare(
			"SELECT * FROM chunks WHERE embedding_model = ? AND embedding IS NOT NULL",
		).all(model) as ChunkDbRow[];
		return rows.map(mapRow);
	}

	/** All chunk id/text pairs, for `/smem rebuild` re-embedding. */
	chunksToReembed(): { id: number; text: string }[] {
		return this.db.prepare("SELECT id, text FROM chunks ORDER BY id").all() as { id: number; text: string }[];
	}

	/** Mark every non-compacted chunk as compacted (compaction boundary, §3). Returns the count updated. */
	markAllCompacted(): number {
		const res = this.db.prepare("UPDATE chunks SET compacted = 1 WHERE compacted = 0").run();
		return res.changes;
	}

	/** Total chunk count. */
	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
		return row.n;
	}

	/** Count of chunks with a usable embedding. */
	countEmbedded(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL").get() as { n: number };
		return row.n;
	}

	/** Count of compacted chunks. */
	countCompacted(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE compacted = 1").get() as { n: number };
		return row.n;
	}

	/** Delete every chunk; returns the number deleted. */
	clear(): number {
		const res = this.db.prepare("DELETE FROM chunks").run();
		return res.changes;
	}

	/** Resolve a chunk id by its session-scoped text hash. */
	private chunkIdByHash(sessionId: string, hash: string): number {
		const row = this.db.prepare(
			"SELECT id FROM chunks WHERE session_id = ? AND text_hash = ?",
		).get(sessionId, hash) as { id: number };
		return row.id;
	}
}

/** Raw DB row shape (compacted stored as 0/1 integer, embedding as BLOB). */
interface ChunkDbRow {
	id: number;
	session_id: string;
	role: IndexedRole;
	turn_no: number;
	text: string;
	text_hash: string;
	embedding: Uint8Array | null;
	embedding_model: string | null;
	token_estimate: number;
	created_at: number;
	compacted: number;
}

/** Map a raw DB row to a ChunkRow (decode embedding, normalise the compacted flag). */
function mapRow(raw: ChunkDbRow): ChunkRow {
	return {
		id: raw.id,
		sessionId: raw.session_id,
		role: raw.role,
		turnNo: raw.turn_no,
		text: raw.text,
		textHash: raw.text_hash,
		embedding: decodeVector(raw.embedding),
		embeddingModel: raw.embedding_model,
		tokenEstimate: raw.token_estimate,
		createdAt: raw.created_at,
		compacted: raw.compacted === 1,
	};
}
