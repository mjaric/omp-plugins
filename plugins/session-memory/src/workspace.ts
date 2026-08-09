/**
 * Workspace identity and storage-path derivation.
 *
 * Mirrors file-graph's scheme exactly: `<basename>-<sha256-12>` of the resolved
 * absolute workspace path, rooted under `~/.omp/session-memory/`.
 */

import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

/** `<basename>-<hash>` workspace identifier (matches the mnemopi bank-id scheme). */
export function workspaceId(absWorkspace: string): string {
	const resolved = resolve(absWorkspace);
	const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
	return `${basename(resolved)}-${hash}`;
}

/** Directory holding the session-memory index + telemetry for a workspace. */
export function storeDir(absWorkspace: string): string {
	return join(homedir(), ".omp", "session-memory", workspaceId(absWorkspace));
}

/** Full path to the `index.sqlite` database for a workspace. */
export function storePath(absWorkspace: string): string {
	return join(storeDir(absWorkspace), "index.sqlite");
}

/** Full path to the append-only `turns.jsonl` telemetry log for a workspace. */
export function telemetryPath(absWorkspace: string): string {
	return join(storeDir(absWorkspace), "turns.jsonl");
}

/** Stable SHA-256 hex hash of a chunk's text (dedup key, spec §6.2). */
export function textHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
