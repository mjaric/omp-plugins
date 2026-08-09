/**
 * Workspace identity, storage path, and markdown-file discovery.
 *
 * The store lives OUTSIDE the user project at
 * `~/.omp/file-graph/<basename>-<hash>/graph.sqlite` where the hash is a
 * stable digest of the absolute workspace path — independent of git layout,
 * matching mnemopi's bank-id derivation.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** Directories never traversed during the markdown walk. */
const SKIP_DIRS: Record<string, true> = {
	".git": true,
	node_modules: true,
	dist: true,
	".next": true,
	build: true,
	out: true,
	".cache": true,
};

/** `<basename>-<hash>` workspace identifier (matches mnemopi bank-id scheme). */
export function workspaceId(absWorkspace: string): string {
	const resolved = resolve(absWorkspace);
	const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
	return `${basename(resolved)}-${hash}`;
}

/** Directory holding the graph SQLite database for a workspace. */
export function storeDir(absWorkspace: string): string {
	return join(homedir(), ".omp", "file-graph", workspaceId(absWorkspace));
}

/** Full path to the graph database file for a workspace. */
export function storePath(absWorkspace: string): string {
	return join(storeDir(absWorkspace), "graph.sqlite");
}

/** SHA-256 content hash of a file's text (used for incremental reindex). */
export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Mtime in milliseconds for a file path (epoch ms). */
export function mtimeMs(filePath: string): number {
	return statSync(filePath).mtimeMs;
}

/** Read a text file as UTF-8. Throws on missing file (caller handles). */
export function readText(filePath: string): string {
	return readFileSync(filePath, "utf-8");
}

/** Parse a `.gitignore` file into simple negative-ignore patterns. */
export function parseGitignore(absWorkspace: string): string[] {
	try {
		const text = readFileSync(join(absWorkspace, ".gitignore"), "utf-8");
		return text
			.split("\n")
			.map(l => l.trim())
			.filter(l => l.length > 0 && !l.startsWith("#"));
	} catch {
		return [];
	}
}

/** True if a relative path matches a gitignore pattern (simple glob subset). */
function matchesGitignore(relPath: string, patterns: string[]): boolean {
	const normalized = relPath.split(sep).join("/");
	for (const pat of patterns) {
		if (pat.endsWith("/")) {
			if (normalized.includes(pat) || normalized.startsWith(pat)) return true;
		} else if (pat.startsWith("*.")) {
			if (normalized.endsWith(pat.slice(1))) return true;
		} else if (normalized === pat || normalized.startsWith(pat + "/")) {
			return true;
		}
	}
	return false;
}

/** Recursively discover all `*.md` files under a workspace, honouring ignores. */
export function findMarkdownFiles(absWorkspace: string): string[] {
	const gitignore = parseGitignore(absWorkspace);
	const results: string[] = [];
	walk(absWorkspace, absWorkspace, gitignore, results);
	return results.toSorted();
}

function walk(root: string, dir: string, gitignore: string[], out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name.startsWith(".")) continue;
		const full = join(dir, name);
		let isDir: boolean;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			if (SKIP_DIRS[name] === true) continue;
			walk(root, full, gitignore, out);
		} else if (name.endsWith(".md")) {
			const rel = relative(root, full).split(sep).join("/");
			if (gitignore.length > 0 && matchesGitignore(rel, gitignore)) continue;
			out.push(rel);
		}
	}
}
