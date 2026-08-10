/**
 * Board sync — the mutation half of a round.
 *
 * Promotes unblocked + acceptance-complete Backlog items to Ready, moves
 * In progress items with a green-CI linked PR to In review (undrafting
 * the PR), and moves merged In review items to Done. Never dispatches
 * workers and never emits prompts; the skill owns orchestration.
 */

import type { SingleProjectConfig } from "../config/forge-toml";
import { getBoardState } from "../github/board";
import { getBlockers, getAcceptanceStatus, getLinkedPr } from "../github/issue";
import { getCiStatus, markReadyForReview } from "../github/pr";
import { moveCard } from "../github/board";
import type { ForgeGitHubClient } from "../github/client";

/** Result of one sync pass. */
export interface SyncReport {
	promoted: number[];
	done: number[];
	toReview: number[];
	blockedCount: number;
}

/** Promote eligible backlog and close out merged review items. */
export async function syncBoard(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
): Promise<SyncReport> {
	const state = await getBoardState(client, config);

	// 1. Merged In review items → Done
	const done: number[] = [];
	const mergedReview = state.items.filter((i) => i.status === "In review" && i.state === "CLOSED");
	for (const item of mergedReview) {
		await moveCard(client, config, item.issueNumber, "done");
		done.push(item.issueNumber);
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

	// 3. Unblocked + acceptance-complete Backlog → Ready
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

	return { promoted, done, toReview, blockedCount };
}

/** Format a sync report as a terse human-readable string. */
export function formatSyncReport(report: SyncReport): string {
	const list = (nums: number[]) =>
		nums.length > 0 ? nums.map((n) => `#${n}`).join(", ") : "(none)";
	return [
		"Forge sync:",
		`  Promoted to Ready: ${list(report.promoted)}`,
		`  To In review:      ${list(report.toReview)}`,
		`  Done (merged):     ${list(report.done)}`,
		`  Blocked (Backlog): ${report.blockedCount}`,
	].join("\n");
}
