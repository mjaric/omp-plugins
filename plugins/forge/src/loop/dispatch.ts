/**
 * Issue dispatch — verify blockers, move the card, build the worker prompt.
 *
 * Shared by `/forge dispatch` (slash command) and the `forge_dispatch`
 * agent tool. No LLM call: the returned prompt is handed to whoever
 * invoked us to spawn a worker.
 */

import type { SingleProjectConfig } from "../config/forge-toml";
import { moveCard } from "../github/board";
import { getBlockers, getIssueBody } from "../github/issue";
import type { ForgeGitHubClient } from "../github/client";

export type DispatchResult =
	| { ok: true; prompt: string }
	| { ok: false; error: string };

/** Build the worker prompt for an issue (issue body + rules + gate). */
export function buildWorkerPrompt(
	config: SingleProjectConfig,
	issueNum: number,
	body: string,
): string {
	const gate = config.gate.map((g) => `  ${g}`).join("\n");
	const slug = (config.repo.split("/")[1] ?? "task").toLowerCase();

	return [
		`Implement issue #${issueNum} in repo ${config.repo}.`,
		"",
		body,
		"",
		"## Rules (non-negotiable)",
		`- Work in branch \`impl/${issueNum}-${slug}\`; never touch main.`,
		"- TDD: write failing tests for each acceptance criterion first.",
		"- Gate before yielding (ALL must pass, zero warnings):",
		gate,
		`- Open a draft PR with "Fixes #${issueNum}". Report PR URL + test names.`,
	].join("\n");
}

/**
 * Verify an issue is unblocked, move it to In progress, and return the
 * worker prompt. Refuses (without touching the board) when blockers
 * are open.
 */
export async function dispatchIssue(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	issueNum: number,
): Promise<DispatchResult> {
	const blockers = await getBlockers(client, config.repo, issueNum);
	if (blockers.openBlockers.length > 0) {
		const list = blockers.openBlockers.map((n) => `#${n}`).join(", ");
		return { ok: false, error: `#${issueNum} blocked by open issues: ${list}.` };
	}

	await moveCard(client, config, issueNum, "in_progress");
	const body = await getIssueBody(client, config.repo, issueNum);
	return { ok: true, prompt: buildWorkerPrompt(config, issueNum, body) };
}
