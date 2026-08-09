/**
 * Issue operations — blocker checks, linked PR resolution, acceptance parsing.
 */

import type { ForgeGitHubClient } from "./client";

export interface IssueBlockers {
	openBlockers: number[];
	allBlockers: number[];
}

export interface AcceptanceStatus {
	complete: boolean;
	missing: string[];
}

/** Extract blocker issue numbers from issue body text ("Blocked by #N"). Exported for testing. */
export function parseBodyBlockers(body: string): number[] {
	const numbers: number[] = [];
	// Match "Blocked by #N", "blocked-by #N", "Depends on #N", "blocked by #12, #13"
	const pattern = /(?:blocked by|blocked-by|depends on|dependency:)\s*#?(\d+(?:\s*,\s*#?\d+)*)/gi;
	for (const match of body.matchAll(pattern)) {
		const nums = match[1]?.split(/[, ]+/).filter((s) => s.length > 0) ?? [];
		for (const num of nums) {
			const parsed = parseInt(num.replace("#", ""), 10);
			if (!Number.isNaN(parsed)) {
				numbers.push(parsed);
			}
		}
	}
	return numbers;
}

/** Get blockers for an issue, checking which are still open. */
export async function getBlockers(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
): Promise<IssueBlockers> {
	// Fetch issue body + timeline events for cross-references
	const [owner, repoName] = repo.split("/");

	const issueResponse = await client.rest.issues.get({
		owner: owner ?? "",
		repo: repoName ?? "",
		issue_number: issueNumber,
	});

	const body = issueResponse.data.body ?? "";
	const bodyBlockers = parseBodyBlockers(body);

	// Deduplicate
	const allBlockers = [...new Set(bodyBlockers)];
	if (allBlockers.length === 0) {
		return { openBlockers: [], allBlockers: [] };
	}

	// Check which blockers are still open
	const openBlockers: number[] = [];
	for (const blockerNum of allBlockers) {
		try {
			const blockerResponse = await client.rest.issues.get({
				owner: owner ?? "",
				repo: repoName ?? "",
				issue_number: blockerNum,
			});
			if (blockerResponse.data.state === "open") {
				openBlockers.push(blockerNum);
			}
		} catch {
			// If we can't fetch the blocker, assume it's open (conservative)
			openBlockers.push(blockerNum);
		}
	}

	return { openBlockers, allBlockers };
}

/** Find the PR linked to an issue (via closing reference or cross-reference). */
export async function getLinkedPr(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
): Promise<number | null> {
	const [owner, repoName] = repo.split("/");

	const timeline = await client.rest.issues.listEventsForTimeline({
		owner: owner ?? "",
		repo: repoName ?? "",
		issue_number: issueNumber,
		per_page: 100,
	});

	// Look for "cross-referenced" events that reference a PR
	// Octokit's timeline event union doesn't type `source` on all variants,
	// so we narrow via event name + structural cast.
	for (const event of timeline.data) {
		if (event.event !== "cross-referenced") {
			continue;
		}
		const source = (event as { source?: { issue?: { number: number; pull_request?: unknown } } }).source;
		if (source?.issue?.pull_request !== undefined) {
			return source.issue.number;
		}
	}

	return null;
}

/** Parse the Acceptance section of an issue body. */
export function parseAcceptance(body: string): AcceptanceStatus {
	const lines = body.split("\n");

	// Find the Acceptance heading
	let startIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.trim().match(/^#+\s*Acceptance/i)) {
			startIndex = i + 1;
			break;
		}
	}

	if (startIndex === -1) {
		return { complete: false, missing: ["no Acceptance section found"] };
	}

	// Collect unchecked boxes until the next heading
	const missing: string[] = [];
	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.startsWith("#")) {
			break; // next section
		}
		const uncheckedMatch = line.match(/^-\s*\[\s*\]\s*(.+)/);
		if (uncheckedMatch?.[1]) {
			missing.push(uncheckedMatch[1].trim());
		}
	}

	return { complete: missing.length === 0, missing };
}

/** Get the acceptance status for an issue by fetching its body. */
export async function getAcceptanceStatus(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
): Promise<AcceptanceStatus> {
	const [owner, repoName] = repo.split("/");

	const response = await client.rest.issues.get({
		owner: owner ?? "",
		repo: repoName ?? "",
		issue_number: issueNumber,
	});

	return parseAcceptance(response.data.body ?? "");
}

/** Fetch the full issue body for prompt construction. */
export async function getIssueBody(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
): Promise<string> {
	const [owner, repoName] = repo.split("/");

	const response = await client.rest.issues.get({
		owner: owner ?? "",
		repo: repoName ?? "",
		issue_number: issueNumber,
	});

	return response.data.body ?? "";
}

/** Close an issue with a comment. */
export async function closeIssueWithComment(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
	comment: string,
): Promise<void> {
	const [owner, repoName] = repo.split("/");

	await client.rest.issues.createComment({
		owner: owner ?? "",
		repo: repoName ?? "",
		issue_number: issueNumber,
		body: comment,
	});

	await client.rest.issues.update({
		owner: owner ?? "",
		repo: repoName ?? "",
		issue_number: issueNumber,
		state: "closed",
	});
}
