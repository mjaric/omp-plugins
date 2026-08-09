/**
 * forge extension factory.
 *
 * Registers the `/forge` slash command. Best-effort: if config or GitHub
 * auth is unavailable, commands report "not initialized" and the session
 * keeps working.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerForgeCommand } from "./commands/forge-command";

export default function forge(pi: ExtensionAPI): void {
	registerForgeCommand(pi);
	pi.logger.info("[forge] extension loaded");
}
