import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Remote-memory extension factory (skeleton).
 *
 * When fully implemented, this extension will provide:
 * - `session_start`: auto-recall from the project bank
 * - `turn_end`: throttled auto-retain
 * - `session_shutdown`: bounded drain of pending retains
 * - Tools: `rmem_recall`, `rmem_retain`, `rmem_reflect`, `rmem_share`
 *
 * Best-effort startup: if the backend is unreachable or auth fails, the
 * extension goes inert and the session keeps working.
 *
 * TODO: implement client, scoping, tools, and lifecycle handlers per AGENTS.md.
 */
export default function remoteMemory(pi: ExtensionAPI): void {
  pi.setLabel("Remote Memory");

  // Best-effort: no-op until backend client is implemented.
  pi.on("session_start", async (_event, _ctx) => {
    // TODO: recall from project bank (+ global bank in per-project-tagged mode)
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // TODO: bounded drain/flush of pending retains
  });
}
