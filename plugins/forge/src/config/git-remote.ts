/**
 * Git remote resolution — reads `origin` from the working directory and
 * normalizes it to `owner/name`.
 *
 * Used by multi-project config resolution: instead of asking the user for
 * `--project`, we match the current directory's git remote against the
 * `repo` fields declared in `.forge.toml`.
 */

import { spawnSync } from "node:child_process";

/** Read `origin` remote URL from a git working directory. Returns null on any failure. */
export function getOriginRemote(cwd: string): string | null {
	try {
		const result = spawnSync("git", ["remote", "get-url", "origin"], {
			cwd,
			encoding: "utf-8",
			timeout: 5_000,
		});
		if (result.status !== 0 || result.stdout == null) return null;
		const url = result.stdout.trim();
		return url.length > 0 ? url : null;
	} catch {
		return null;
	}
}

/**
 * Normalize any GitHub remote URL form to `owner/name`.
 *
 * Handles:
 * - `git@github.com:owner/name.git`
 * - `https://github.com/owner/name.git`
 * - `ssh://git@github.com/owner/name.git`
 * - `git+https://github.com/owner/name.git`
 *
 * Returns the original string lowercased if it doesn't match a known shape,
 * so callers can still do a fuzzy comparison.
 */
export function normalizeRepoId(remoteUrl: string): string {
	let url = remoteUrl.trim();

	// Strip protocol prefixes
	url = url.replace(/^(git\+)?(https?|ssh|git):\/\//, "");
	url = url.replace(/^git@/, "");

	// Remove host portion (everything up to and including the first / or :)
	// git@github.com:owner/name.git → github.com:owner/name.git after git@ strip
	// → :owner/name.git after host strip
	// https://github.com/owner/name.git → github.com/owner/name.git after proto strip
	// → /owner/name.git after host strip
	const hostEnd = url.search(/[:/]/);
	if (hostEnd === -1) return url.toLowerCase();

	url = url.slice(hostEnd + 1);

	// Remove .git suffix
	url = url.replace(/\.git$/, "");

	return url.toLowerCase();
}
