/**
 * Issue dispatch — verify blockers, move the card, build the worker prompt.
 *
 * Shared by `/forge dispatch` (slash command) and the `forge_dispatch`
 * agent tool. No LLM call: the returned prompt is handed to whoever
 * invoked us to spawn a worker.
 */

import type { SingleProjectConfig } from "../config/forge-toml";
import { moveCard } from "../github/board";
import { getBlockers, getIssueTitleAndBody } from "../github/issue";
import type { ForgeGitHubClient } from "../github/client";

export type DispatchResult =
	| { ok: true; prompt: string }
	| { ok: false; error: string };

/** Slugify an issue title into a branch-suffix token. Exported for testing. */
export function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.slice(0, 40) || "task";
}

/** Branch name for a dispatched issue: `impl/<issue>-<title-slug>`. */
export function workerBranch(issueNum: number, title: string): string {
	return `impl/${issueNum}-${slugifyTitle(title)}`;
}

/** Build the worker prompt for an issue (issue body + rules + gate). */
export function buildWorkerPrompt(
	config: SingleProjectConfig,
	issueNum: number,
	title: string,
	body: string,
): string {
	const gate = config.gate.map((g) => `  ${g}`).join("\n");

	return [
		`Implement issue #${issueNum} in repo ${config.repo}.`,
		"",
		body,
		"",
		"## Rules (non-negotiable)",
		`- Work in branch \`${workerBranch(issueNum, title)}\`; never touch main.`,
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
	const issue = await getIssueTitleAndBody(client, config.repo, issueNum);
	return { ok: true, prompt: buildWorkerPrompt(config, issueNum, issue.title, issue.body) };
}
