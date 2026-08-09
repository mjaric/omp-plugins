/**
 * Config loader — reads .forge.toml from the project root.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseForgeToml, type ForgeConfig } from "./forge-toml";

/** Load forge config from cwd. Returns null if .forge.toml doesn't exist. */
export function loadConfig(cwd: string): ForgeConfig | null {
	const configPath = join(cwd, ".forge.toml");
	if (!existsSync(configPath)) {
		return null;
	}

	const content = readFileSync(configPath, "utf-8");
	return parseForgeToml(content);
}
