/**
 * forge extension factory.
 *
 * Registers the `/forge` slash command. Best-effort: if config or GitHub
 * auth is unavailable, commands report "not initialized" and the session
 * keeps working.
 *
 * When `self_improvement = true` in `.forge.toml`, also registers the
 * thinking-level telemetry handler (`turn_end` event) to record per-turn
 * metrics for `/forge thinking-report` and `/forge retrospect`.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerForgeCommand } from "./commands/forge-command";
import { loadConfig } from "./config/forge-config-loader";
import { createTurnEndHandler } from "./telemetry/telemetry";

/** Check if self-improvement is enabled in the config. */
function isSelfImprovementEnabled(cwd: string): boolean {
	const config = loadConfig(cwd);
	if (config === null) return false;
	if ("projects" in config) {
		return config.projects.some((p) => p.selfImprovement === true);
	}
	return config.selfImprovement === true;
}

/** Register telemetry handler if self_improvement is enabled. */
function registerTelemetry(pi: ExtensionAPI): void {
	const enabled = isSelfImprovementEnabled(process.cwd());
	if (!enabled) return;

	pi.on("turn_end", createTurnEndHandler(pi));
	pi.logger.info("[forge] self-improvement enabled — telemetry active");
}

export default function forge(pi: ExtensionAPI): void {
	registerForgeCommand(pi);
	registerTelemetry(pi);
	pi.logger.info("[forge] extension loaded");
}
