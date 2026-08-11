/**
 * PR operations — CI status checks, review feedback, and review
 * contract assembly.
 */

import type { ForgeGitHubClient } from "./client";
import { getIssueTitleAndBody, getLinkedPr } from "./issue";

export type CiState = "pass" | "fail" | "pending" | "none";

export interface ReviewContract {
	issueNumber: number;
	scope: string;
	specReferences: string;
	acceptance: string;
}

/** Human review feedback on a PR: latest verdict per reviewer + comments. */
export interface ReviewFeedback {
	/** True while any reviewer's latest verdict is CHANGES_REQUESTED. */
	requestedChanges: boolean;
	reviews: Array<{ author: string; state: string; body: string }>;
	comments: Array<{ author: string; path: string | null; body: string }>;
}

/** Empty feedback for PRs with no review activity. */
export const EMPTY_FEEDBACK: ReviewFeedback = { requestedChanges: false, reviews: [], comments: [] };

/** Cap on feedback comments carried into a contract (rate-limit + prompt size). */
const MAX_FEEDBACK_COMMENTS = 30;

/** Split a GitHub repo id into owner/name with empty-string fallbacks. */
function repoParts(repo: string): { owner: string; repoName: string } {
	const [owner, repoName] = repo.split("/");
	return { owner: owner ?? "", repoName: repoName ?? "" };
}

/** Get the aggregated CI status for a PR from its check runs. */
export async function getCiStatus(
	client: ForgeGitHubClient,
	repo: string,
	prNumber: number,
): Promise<CiState> {
	const { owner, repoName } = repoParts(repo);

	// Get the PR to find the head SHA
	const prResponse = await client.rest.pulls.get({
		owner,
		repo: repoName,
		pull_number: prNumber,
	});

	const headSha = prResponse.data.head.sha;

	// List check runs for the head commit
	const checksResponse = await client.rest.checks.listForRef({
		owner,
		repo: repoName,
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

/** GraphQL mutation to undraft a PR (REST has no ready-for-review endpoint). */
const MARK_READY_MUTATION = `
mutation($id: ID!) {
	markPullRequestReadyForReview(input: { pullRequestId: $id }) {
		pullRequest { id }
	}
}`;

/** Undraft a PR so the human merge gate is actionable. No-op when not a draft. */
export async function markReadyForReview(
	client: ForgeGitHubClient,
	repo: string,
	prNumber: number,
): Promise<void> {
	const { owner, repoName } = repoParts(repo);
	const prResponse = await client.rest.pulls.get({
		owner,
		repo: repoName,
		pull_number: prNumber,
	});
	if (prResponse.data.draft !== true) return;
	await client.graphql<unknown>(MARK_READY_MUTATION, { id: prResponse.data.node_id });
}

/**
 * Fetch human review feedback for a PR: latest review verdict per
 * reviewer plus review-thread and conversation comments. COMMENTED and
 * DISMISSED reviews never override an APPROVED/CHANGES_REQUESTED verdict.
 */
export async function getReviewFeedback(
	client: ForgeGitHubClient,
	repo: string,
	prNumber: number,
): Promise<ReviewFeedback> {
	const { owner, repoName } = repoParts(repo);

	const [reviews, reviewComments, conversation] = await Promise.all([
		client.rest.pulls.listReviews({ owner, repo: repoName, pull_number: prNumber, per_page: 100 }),
		client.rest.pulls.listReviewComments({ owner, repo: repoName, pull_number: prNumber, per_page: 100 }),
		client.rest.issues.listComments({ owner, repo: repoName, issue_number: prNumber, per_page: 100 }),
	]);

	const latestByAuthor = new Map<string, { state: string; body: string }>();
	for (const review of reviews.data) {
		if (review.state === "COMMENTED" || review.state === "DISMISSED") continue;
		latestByAuthor.set(review.user?.login ?? "unknown", {
			state: review.state,
			body: review.body ?? "",
		});
	}

	const comments: ReviewFeedback["comments"] = [];
	for (const c of reviewComments.data) {
		comments.push({ author: c.user?.login ?? "unknown", path: c.path ?? null, body: c.body ?? "" });
	}
	for (const c of conversation.data) {
		comments.push({ author: c.user?.login ?? "unknown", path: null, body: c.body ?? "" });
	}

	return {
		requestedChanges: [...latestByAuthor.values()].some((r) => r.state === "CHANGES_REQUESTED"),
		reviews: [...latestByAuthor.entries()].map(([author, r]) => ({ author, state: r.state, body: r.body })),
		comments: comments.slice(0, MAX_FEEDBACK_COMMENTS),
	};
}

/** Clip a comment body to one line for prompt embedding. */
function clip(text: string, max = 400): string {
	const flat = text.trim().replace(/\s+/g, " ");
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Render human review feedback as contract lines. */
function formatFeedback(feedback: ReviewFeedback): string[] {
	if (feedback.reviews.length === 0 && feedback.comments.length === 0) {
		return ["### Human review feedback", "(none)"];
	}
	const lines = ["### Human review feedback"];
	const changes = feedback.reviews.filter((r) => r.state === "CHANGES_REQUESTED");
	if (changes.length > 0) {
		lines.push(`Requested changes by: ${changes.map((r) => `@${r.author}`).join(", ")}`);
	}
	for (const review of feedback.reviews) {
		if (review.body.trim().length === 0) continue;
		lines.push(`- @${review.author} [${review.state}]: ${clip(review.body)}`);
	}
	for (const comment of feedback.comments) {
		const where = comment.path !== null ? ` on ${comment.path}` : "";
		lines.push(`- @${comment.author}${where}: ${clip(comment.body)}`);
	}
	return lines;
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

/** Format a review contract as a prompt-ready string, with optional feedback. */
export function formatReviewContract(contract: ReviewContract, feedback?: ReviewFeedback): string {
	const lines = [
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
	];
	if (feedback !== undefined) {
		lines.push("", ...formatFeedback(feedback));
	}
	return lines.join("\n");
}

/** Full contract plus resolved PR number and human feedback. */
export interface FullReviewContract extends ReviewContract {
	pr: number | null;
	feedback: ReviewFeedback;
}

/**
 * Assemble the full review contract for an issue or PR number: fetch
 * the issue/PR body (sections) plus human review feedback. Resolves
 * issue numbers to their linked PR for feedback lookup.
 */
export async function assembleReviewContract(
	client: ForgeGitHubClient,
	repo: string,
	number: number,
): Promise<FullReviewContract> {
	const { body } = await getIssueTitleAndBody(client, repo, number);
	const contract = buildReviewContract(number, body);

	const pr = await resolvePrNumber(client, repo, number);
	const feedback = pr === null ? EMPTY_FEEDBACK : await getReviewFeedback(client, repo, pr);
	return { ...contract, pr, feedback };
}

/** Resolve a number to a PR number: itself when it is a PR, else the linked PR. */
async function resolvePrNumber(
	client: ForgeGitHubClient,
	repo: string,
	number: number,
): Promise<number | null> {
	const { owner, repoName } = repoParts(repo);
	try {
		const pr = await client.rest.pulls.get({ owner, repo: repoName, pull_number: number });
		return pr.data.number;
	} catch {
		// Not a PR number — fall through to linked-PR lookup.
	}
	return getLinkedPr(client, repo, number);
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
