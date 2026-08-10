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

interface NativeBlockerNode {
	number: number;
	state: string;
}

interface NativeBlockerResponse {
	repository?: { issue?: { blockedBy?: { nodes?: NativeBlockerNode[] } } };
}

/** GraphQL query for native GitHub blocked-by relationships. */
const BLOCKED_BY_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		issue(number: $number) {
			blockedBy(first: 50) { nodes { number state } }
		}
	}
}`;

/** Native blocked-by relationship numbers (sidebar links). Empty when unsupported. */
async function getNativeBlockerNumbers(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
): Promise<number[]> {
	const [owner, repoName] = repo.split("/");
	try {
		const data = await client.graphql<NativeBlockerResponse>(BLOCKED_BY_QUERY, {
			owner: owner ?? "",
			name: repoName ?? "",
			number: issueNumber,
		});
		return (data.repository?.issue?.blockedBy?.nodes ?? []).map((n) => n.number);
	} catch {
		// Native relationships unsupported or unreachable — body text stays authoritative.
		return [];
	}
}

/** Check which candidate blockers are still open (unfetchable = open). */
async function resolveOpenBlockers(
	client: ForgeGitHubClient,
	repo: string,
	candidates: number[],
): Promise<number[]> {
	const [owner, repoName] = repo.split("/");
	const openBlockers: number[] = [];
	for (const blockerNum of candidates) {
		try {
			const response = await client.rest.issues.get({
				owner: owner ?? "",
				repo: repoName ?? "",
				issue_number: blockerNum,
			});
			if (response.data.state === "open") {
				openBlockers.push(blockerNum);
			}
		} catch {
			// If we can't fetch the blocker, assume it's open (conservative)
			openBlockers.push(blockerNum);
		}
	}
	return openBlockers;
}

/** Union native blocked-by links and "Blocked by #N" body text; resolve open state. */
async function collectBlockers(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<IssueBlockers> {
	const native = await getNativeBlockerNumbers(client, repo, issueNumber);
	const allBlockers = [...new Set([...native, ...parseBodyBlockers(body)])];
	if (allBlockers.length === 0) {
		return { openBlockers: [], allBlockers: [] };
	}
	return { openBlockers: await resolveOpenBlockers(client, repo, allBlockers), allBlockers };
}

/** Get blockers for an issue: native blocked-by links first, then body text. */
export async function getBlockers(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
): Promise<IssueBlockers> {
	const [owner, repoName] = repo.split("/");

	const issueResponse = await client.rest.issues.get({
		owner: owner ?? "",
		repo: repoName ?? "",
		issue_number: issueNumber,
	});

	return collectBlockers(client, repo, issueNumber, issueResponse.data.body ?? "");
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

/**
 * Parse the Acceptance section of an issue body.
 *
 * Complete = the section exists and every criterion bullet is written.
 * Checkbox state is the worker's TDD checklist (unchecked at dispatch
 * time by design) and does not gate promotion.
 */
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

	const missing: string[] = [];
	let criteria = 0;
	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.startsWith("#")) {
			break; // next section
		}
		if (!line.startsWith("- ")) continue;
		const text = (line.match(/^-\s*(?:\[[ xX]\]\s*)?(.*)/) ?? [])[1]?.trim() ?? "";
		criteria += 1;
		if (text === "" || /^\[[ xX]?\]$/.test(text)) {
			missing.push(`criterion ${criteria} is empty`);
		}
	}
	if (criteria === 0) {
		missing.push("no acceptance criteria written");
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

/** Blockers + acceptance derived from a single issue fetch. */
export interface IssueDetail {
	blockers: IssueBlockers;
	acceptance: AcceptanceStatus;
}

/** Fetch one issue and derive both blockers and acceptance status. */
export async function getIssueDetail(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
): Promise<IssueDetail> {
	const [owner, repoName] = repo.split("/");

	const response = await client.rest.issues.get({
		owner: owner ?? "",
		repo: repoName ?? "",
		issue_number: issueNumber,
	});
	const body = response.data.body ?? "";

	const blockers = await collectBlockers(client, repo, issueNumber, body);
	return { blockers, acceptance: parseAcceptance(body) };
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
