/**
 * Board sync — the mutation half of a round.
 *
 * Promotes unblocked + acceptance-complete Backlog items to Ready, moves
 * In progress items with a green-CI linked PR to In review (undrafting
 * the PR), bounces In review items back to In progress when a reviewer
 * requested changes, moves merged In review items to Done, and removes
 * leftover worktrees/branches of merged PRs when `cwd` is given.
 * Never dispatches workers and never emits prompts; the skill owns
 * orchestration.
 */

import type { SingleProjectConfig } from "../config/forge-toml";
import { getBoardState } from "../github/board";
import { getBlockers, getAcceptanceStatus, getLinkedPr } from "../github/issue";
import { getCiStatus, getReviewFeedback, markReadyForReview } from "../github/pr";
import { moveCard } from "../github/board";
import { cleanupAfterMerge, type CleanupReport } from "../git/local-cleanup";
import type { ForgeGitHubClient } from "../github/client";

/** Result of one sync pass. */
export interface SyncReport {
	promoted: number[];
	done: number[];
	toReview: number[];
	/** Bounced In review → In progress because a reviewer requested changes. */
	rework: number[];
	blockedCount: number;
	cleanup: CleanupReport | null;
}

/** Sync the board: promotions, review moves, rework bounces, done, cleanup. */
export async function syncBoard(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	cwd?: string,
): Promise<SyncReport> {
	const state = await getBoardState(client, config);

	// 1. Merged In review items → Done (collect merged head refs for cleanup)
	const done: number[] = [];
	const mergedHeadRefs: string[] = [];
	const mergedReview = state.items.filter((i) => i.status === "In review" && i.state === "CLOSED");
	for (const item of mergedReview) {
		await moveCard(client, config, item.issueNumber, "done");
		done.push(item.issueNumber);
		const headRef = await getMergedPrHeadRef(client, config.repo, item.issueNumber);
		if (headRef !== null) mergedHeadRefs.push(headRef);
	}

	// 2. In progress with linked PR + green CI → In review (undraft the PR)
	const toReview: number[] = [];
	const inProgress = state.items.filter((i) => i.status === "In progress" && i.state === "OPEN");
	for (const item of inProgress) {
		const pr = await getLinkedPr(client, config.repo, item.issueNumber);
		if (pr === null) continue;
		if ((await getCiStatus(client, config.repo, pr)) !== "pass") continue;
		await markReadyForReview(client, config.repo, pr);
		await moveCard(client, config, item.issueNumber, "in_review");
		toReview.push(item.issueNumber);
	}

	// 3. In review with changes requested → back to In progress (rework)
	const rework: number[] = [];
	const inReview = state.items.filter((i) => i.status === "In review" && i.state === "OPEN");
	for (const item of inReview) {
		const pr = await getLinkedPr(client, config.repo, item.issueNumber);
		if (pr === null) continue;
		const feedback = await getReviewFeedback(client, config.repo, pr);
		if (!feedback.requestedChanges) continue;
		await moveCard(client, config, item.issueNumber, "in_progress");
		rework.push(item.issueNumber);
	}

	// 4. Unblocked + acceptance-complete Backlog → Ready
	const promoted: number[] = [];
	let blockedCount = 0;
	const backlogItems = state.items.filter((i) => i.status === "Backlog" && i.state === "OPEN");
	for (const item of backlogItems) {
		const blockers = await getBlockers(client, config.repo, item.issueNumber);
		if (blockers.openBlockers.length > 0) {
			blockedCount += 1;
			continue;
		}
		const acceptance = await getAcceptanceStatus(client, config.repo, item.issueNumber);
		if (!acceptance.complete) continue;
		await moveCard(client, config, item.issueNumber, "ready");
		promoted.push(item.issueNumber);
	}

	// 5. Local hygiene — only when merged items landed and a cwd is given
	const cleanup = cwd !== undefined && mergedHeadRefs.length > 0
		? await cleanupAfterMerge(cwd, mergedHeadRefs)
		: null;

	return { promoted, done, toReview, rework, blockedCount, cleanup };
}

/** Head branch of an issue's merged PR (squash-merges git cannot detect). */
async function getMergedPrHeadRef(
	client: ForgeGitHubClient,
	repo: string,
	issueNumber: number,
): Promise<string | null> {
	const [owner, repoName] = repo.split("/");
	const pr = await getLinkedPr(client, repo, issueNumber);
	if (pr === null) return null;
	try {
		const response = await client.rest.pulls.get({
			owner: owner ?? "",
			repo: repoName ?? "",
			pull_number: pr,
		});
		return response.data.head.ref;
	} catch {
		return null;
	}
}

/** Format a sync report as a terse human-readable string. */
export function formatSyncReport(report: SyncReport): string {
	const list = (nums: number[]) =>
		nums.length > 0 ? nums.map((n) => `#${n}`).join(", ") : "(none)";
	const lines = [
		"Forge sync:",
		`  Promoted to Ready:  ${list(report.promoted)}`,
		`  To In review:       ${list(report.toReview)}`,
		`  Rework (bounced):   ${list(report.rework)}`,
		`  Done (merged):      ${list(report.done)}`,
		`  Blocked (Backlog):  ${report.blockedCount}`,
	];
	if (report.cleanup !== null) {
		lines.push(formatCleanupLines(report.cleanup));
	}
	return lines.join("\n");
}

/** Format cleanup details as indented sync lines. */
function formatCleanupLines(cleanup: CleanupReport): string {
	const parts: string[] = [];
	if (cleanup.worktreesRemoved.length > 0) parts.push(`worktrees removed: ${cleanup.worktreesRemoved.join(", ")}`);
	if (cleanup.branchesDeleted.length > 0) parts.push(`branches deleted: ${cleanup.branchesDeleted.join(", ")}`);
	for (const skip of cleanup.skipped) parts.push(`skipped ${skip.ref} (${skip.reason})`);
	return parts.length > 0 ? `  Local cleanup: ${parts.join("; ")}` : "  Local cleanup: nothing to remove.";
}
