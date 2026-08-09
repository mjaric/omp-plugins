/**
 * GitHub authentication: resolves a token using the same chain as `gh` CLI.
 *
 * Resolution order:
 * 1. `~/.config/gh/hosts.yml` — the file `gh auth login` writes. Parse the
 *    `oauth_token` under `github.com:` (or the enterprise host if configured).
 * 2. `gh auth token` — handles keyring-backed auth (macOS Keychain, etc.).
 * 3. `GH_TOKEN` environment variable.
 * 4. `GITHUB_TOKEN` environment variable.
 *
 * Returns `null` when no token is found — callers MUST handle this by going
 * inert (forge commands report "not initialized" rather than crashing).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GhAuth {
	token: string;
	source: "hosts-yml" | "gh-cli" | "env";
}

/** Default GitHub host (enterprise hosts would need config support — deferred). */
const DEFAULT_HOST = "github.com";

/** Path to gh CLI's credentials file. */
const HOSTS_YML_PATH = join(homedir(), ".config", "gh", "hosts.yml");

/** Extract oauth_token from hosts.yml content for the default host. */
function parseHostsYml(content: string, host: string): string | null {
	const lines = content.split("\n");
	let inHost = false;
	for (const line of lines) {
		const trimmed = line.trimEnd();
		// Host header: "github.com:" at column 0
		if (!trimmed.startsWith(" ") && trimmed.endsWith(":")) {
			inHost = trimmed.slice(0, -1).trim() === host;
			continue;
		}
		if (inHost) {
			// Indented property: "    oauth_token: gho_..."
			const match = trimmed.match(/^\s+oauth_token:\s*(\S+)\s*$/);
			if (match) {
				return match[1] ?? null;
			}
		}
	}
	return null;
}

/** Read the token from hosts.yml, returning null on any failure. */
function readHostsYmlToken(): string | null {
	try {
		const content = readFileSync(HOSTS_YML_PATH, "utf-8");
		return parseHostsYml(content, DEFAULT_HOST);
	} catch {
		return null;
	}
}

/** Read the token via `gh auth token` (handles keyring-backed auth). */
function readGhCliToken(): string | null {
	try {
		const result = Bun.spawnSync({
			cmd: ["gh", "auth", "token"],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) {
			const token = Buffer.from(result.stdout).toString().trim();
			if (token.length > 0) {
				return token;
			}
		}
	} catch {
		// gh CLI not available
	}
	return null;
}

/** Read the token from environment, preferring GH_TOKEN over GITHUB_TOKEN. */
function readEnvToken(): string | null {
	const ghToken = process.env["GH_TOKEN"];
	if (ghToken !== undefined && ghToken.length > 0) {
		return ghToken;
	}
	const githubToken = process.env["GITHUB_TOKEN"];
	if (githubToken !== undefined && githubToken.length > 0) {
		return githubToken;
	}
	return null;
}

export function resolveGhToken(): GhAuth | null {
	const hostsToken = readHostsYmlToken();
	if (hostsToken !== null) {
		return { token: hostsToken, source: "hosts-yml" };
	}

	const cliToken = readGhCliToken();
	if (cliToken !== null) {
		return { token: cliToken, source: "gh-cli" };
 	}
	const envToken = readEnvToken();
	if (envToken !== null) {
		return { token: envToken, source: "env" };
	}

	return null;
}
