/**
 * PR operations — CI status checks and review contract assembly.
 */

import type { ForgeGitHubClient } from "./client";

export type CiState = "pass" | "fail" | "pending" | "none";

export interface ReviewContract {
	issueNumber: number;
	scope: string;
	specReferences: string;
	acceptance: string;
}

/** Get the aggregated CI status for a PR from its check runs. */
export async function getCiStatus(
	client: ForgeGitHubClient,
	repo: string,
	prNumber: number,
): Promise<CiState> {
	const [owner, repoName] = repo.split("/");

	// Get the PR to find the head SHA
	const prResponse = await client.rest.pulls.get({
		owner: owner ?? "",
		repo: repoName ?? "",
		pull_number: prNumber,
	});

	const headSha = prResponse.data.head.sha;

	// List check runs for the head commit
	const checksResponse = await client.rest.checks.listForRef({
		owner: owner ?? "",
		repo: repoName ?? "",
		ref: headSha,
		per_page: 100,
	});

	if (checksResponse.data.check_runs.length === 0) {
		return "none";
	}

	let hasPending = false;
	let hasFailure = false;

	for (const run of checksResponse.data.check_runs) {
		if (run.status === "queued" || run.status === "in_progress") {
			hasPending = true;
		}
		if (run.conclusion === "failure" || run.conclusion === "cancelled" || run.conclusion === "timed_out") {
			hasFailure = true;
		}
	}

	if (hasFailure) {
		return "fail";
	}
	if (hasPending) {
		return "pending";
	}

	// All completed + all success/neutral
	const allComplete = checksResponse.data.check_runs.every(
		(run) => run.status === "completed",
	);
	if (!allComplete) {
		return "pending";
	}

	return "pass";
}

/** Assemble the review contract from an issue body for the reviewer agent. */
export function buildReviewContract(issueNumber: number, body: string): ReviewContract {
	const sections = splitIntoSections(body);

	return {
		issueNumber,
		scope: sections["scope"] ?? "(no scope section)",
		specReferences: sections["spec references"] ?? "(no spec references)",
		acceptance: sections["acceptance"] ?? "(no acceptance section)",
	};
}

/** Format a review contract as a prompt-ready string. */
export function formatReviewContract(contract: ReviewContract): string {
	return [
		`## Issue #${contract.issueNumber} — Review Contract`,
		"",
		"### Scope",
		contract.scope,
		"",
		"### Spec references",
		contract.specReferences,
		"",
		"### Acceptance criteria",
		contract.acceptance,
	].join("\n");
}

/** Split an issue body into named sections keyed by lowercased heading. */
function splitIntoSections(body: string): Record<string, string> {
	const result: Record<string, string> = {};
	const lines = body.split("\n");
	let currentHeading: string | null = null;
	let currentContent: string[] = [];

	for (const line of lines) {
		const headingMatch = line.match(/^#+\s*(.+)/);
		if (headingMatch?.[1]) {
			if (currentHeading !== null) {
				result[currentHeading] = currentContent.join("\n").trim();
			}
			currentHeading = headingMatch[1].toLowerCase().trim();
			currentContent = [];
		} else if (currentHeading !== null) {
			currentContent.push(line);
		}
	}

	if (currentHeading !== null) {
		result[currentHeading] = currentContent.join("\n").trim();
	}

	return result;
}
