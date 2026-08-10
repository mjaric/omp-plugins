/**
 * Config resolution shared by slash commands and agent tools.
 *
 * Commands wrap failures in UI notifications; tools wrap them in
 * `isError` results. Both resolve the same way: `.forge.toml` from
 * cwd, multi-project configs matched against the git remote origin.
 */

import { loadConfig } from "../config/forge-config-loader";
import { getOriginRemote, normalizeRepoId } from "../config/git-remote";
import { getGitHubClient, type ForgeGitHubClient } from "../github/client";
import type { SingleProjectConfig } from "../config/forge-toml";

export type ConfigResolution =
	| { ok: true; config: SingleProjectConfig }
	| { ok: false; error: string };

export type ResolvedForge =
	| { ok: true; client: ForgeGitHubClient; config: SingleProjectConfig }
	| { ok: false; error: string };

/** Resolve the single-project config from cwd, or an actionable error.
 *
 * Single-project config is returned directly. Multi-project (submodules)
 * config is resolved by matching the current directory's git remote origin
 * against each project's `repo` field — no manual `--project` flag needed.
 */
export function resolveProjectConfig(cwd: string): ConfigResolution {
	const config = loadConfig(cwd);
	if (config === null) {
		return { ok: false, error: ".forge.toml not found. Run `/forge setup` first." };
	}
	if ("projects" in config === false) {
		return { ok: true, config };
	}

	const origin = getOriginRemote(cwd);
	if (origin === null) {
		const repos = config.projects.map((p) => p.repo).join(", ");
		return {
			ok: false,
			error: `Multi-project mode — could not read git remote origin. Expected one of: ${repos}.`,
		};
	}

	const originId = normalizeRepoId(origin);
	const project = config.projects.find((p) => normalizeRepoId(p.repo) === originId);
	if (project === undefined) {
		const repos = config.projects.map((p) => p.repo).join(", ");
		return {
			ok: false,
			error: `Remote origin (${origin}) does not match any project in .forge.toml. Expected one of: ${repos}.`,
		};
	}

	const { path: _path, ...single } = project;
	void _path;
	return { ok: true, config: single };
}

/** Resolve client + single-project config from cwd, or an actionable error. */
export function resolveForge(cwd: string): ResolvedForge {
	const client = getGitHubClient();
	if (client === null) {
		return {
			ok: false,
			error: "GitHub auth not found. Run `gh auth login` or set GH_TOKEN.",
		};
	}

	const configResolution = resolveProjectConfig(cwd);
	if (!configResolution.ok) {
		return configResolution;
	}
	return { ok: true, client, config: configResolution.config };
}
