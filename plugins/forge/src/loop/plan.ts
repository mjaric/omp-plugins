/**
 * Round plan builder — pure query layer for the sdlc skill.
 *
 * `buildForgePlan` inspects the board without mutating anything:
 * Ready items (blockers re-verified) are dispatchable; Backlog items
 * are blocked / not-ready / promotable; In review items with a linked
 * PR are reviewable. Milestone completion is summarized for the loop
 * stop condition. The skill runs `/forge round` first (promote + done
 * sync), then reads this plan, dispatches up to `maxWorkers`, and
 * reviews pending PRs.
 */

import type { SingleProjectConfig } from "../config/forge-toml";
import { getBoardState, type BoardItem } from "../github/board";
import { getIssueDetail, getLinkedPr } from "../github/issue";
import { getCiStatus, type CiState } from "../github/pr";
import type { ForgeGitHubClient } from "../github/client";

/** A Ready issue eligible for dispatch (blockers re-verified). */
export interface DispatchableItem {
	issue: number;
	title: string;
	milestone: string | null;
}

/** An issue whose open blockers were found. */
export interface BlockedItem {
	issue: number;
	title: string;
	status: string;
	openBlockers: number[];
}

/** A Backlog issue whose acceptance criteria are not yet written. */
export interface NotReadyItem {
	issue: number;
	title: string;
	missing: string[];
}

/** A Backlog issue eligible for promotion to Ready on the next round. */
export interface PromotableItem {
	issue: number;
	title: string;
}

/** An In review issue with a linked PR. */
export interface ReviewableItem {
	issue: number;
	title: string;
	pr: number;
	ci: CiState;
}

/** An open issue whose title flags an unresolved decision. */
export interface NeedsDecisionItem {
	issue: number;
	title: string;
}

/** Open/done counts for one milestone title. */
export interface MilestoneSummary {
	name: string;
	open: number;
	done: number;
	/** True when the milestone has items and none are open. */
	complete: boolean;
}

/** Full query-only round plan. */
export interface ForgePlan {
	repo: string;
	dispatchable: DispatchableItem[];
	blocked: BlockedItem[];
	notReady: NotReadyItem[];
	promotable: PromotableItem[];
	reviewable: ReviewableItem[];
	inProgress: number[];
	needsDecision: NeedsDecisionItem[];
	milestones: MilestoneSummary[];
	/** True when nothing is actionable and nothing is in flight. */
	idle: boolean;
}

/** Cap the dispatchable list at `maxWorkers`. */
export function capDispatchable(
	items: DispatchableItem[],
	maxWorkers: number,
): DispatchableItem[] {
	return items.slice(0, maxWorkers);
}

/** Aggregate open/done counts per milestone across all board items. */
export function summarizeMilestones(items: BoardItem[]): MilestoneSummary[] {
	const counts = new Map<string, { open: number; done: number }>();
	for (const item of items) {
		if (item.milestone === null) continue;
		const entry = counts.get(item.milestone) ?? { open: 0, done: 0 };
		if (item.status === "Done" || item.state === "CLOSED") {
			entry.done += 1;
		} else {
			entry.open += 1;
		}
		counts.set(item.milestone, entry);
	}

	const summaries: MilestoneSummary[] = [];
	for (const [name, { open, done }] of counts) {
		summaries.push({ name, open, done, complete: open === 0 && done > 0 });
	}
	return summaries;
}

/** Classify one Ready item: dispatchable unless a blocker reopened. */
async function classifyReady(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	item: BoardItem,
	dispatchable: DispatchableItem[],
	blocked: BlockedItem[],
): Promise<void> {
	const detail = await getIssueDetail(client, config.repo, item.issueNumber);
	if (detail.blockers.openBlockers.length > 0) {
		blocked.push({
			issue: item.issueNumber,
			title: item.title,
			status: item.status,
			openBlockers: detail.blockers.openBlockers,
		});
	} else {
		dispatchable.push({ issue: item.issueNumber, title: item.title, milestone: item.milestone });
	}
}

/** Classify one Backlog item: blocked / not-ready / promotable. */
async function classifyBacklog(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	item: BoardItem,
	blocked: BlockedItem[],
	notReady: NotReadyItem[],
	promotable: PromotableItem[],
): Promise<void> {
	const detail = await getIssueDetail(client, config.repo, item.issueNumber);
	if (detail.blockers.openBlockers.length > 0) {
		blocked.push({
			issue: item.issueNumber,
			title: item.title,
			status: item.status,
			openBlockers: detail.blockers.openBlockers,
		});
	} else if (!detail.acceptance.complete) {
		notReady.push({
			issue: item.issueNumber,
			title: item.title,
			missing: detail.acceptance.missing,
		});
	} else {
		promotable.push({ issue: item.issueNumber, title: item.title });
	}
}

/** Classify one In review item: reviewable when a PR is linked. */
async function classifyInReview(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	item: BoardItem,
	reviewable: ReviewableItem[],
): Promise<void> {
	const pr = await getLinkedPr(client, config.repo, item.issueNumber);
	if (pr === null) return;
	reviewable.push({
		issue: item.issueNumber,
		title: item.title,
		pr,
		ci: await getCiStatus(client, config.repo, pr),
	});
}

/**
 * Build a round plan from live board + GitHub state.
 *
 * GitHub calls run sequentially (rate-limit friendly, deterministic).
 * One issue fetch per Ready/Backlog item (blockers + acceptance
 * combined); one timeline + CI fetch per In review item.
 */
export async function buildForgePlan(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
): Promise<ForgePlan> {
	const state = await getBoardState(client, config);

	const dispatchable: DispatchableItem[] = [];
	const blocked: BlockedItem[] = [];
	const notReady: NotReadyItem[] = [];
	const promotable: PromotableItem[] = [];
	const reviewable: ReviewableItem[] = [];
	const inProgress: number[] = [];
	const needsDecision: NeedsDecisionItem[] = [];

	for (const item of state.items) {
		if (item.state !== "OPEN") continue;
		if (item.title.includes("needs-decision")) {
			needsDecision.push({ issue: item.issueNumber, title: item.title });
		}
		if (item.status === "Ready") {
			await classifyReady(client, config, item, dispatchable, blocked);
		} else if (item.status === "Backlog") {
			await classifyBacklog(client, config, item, blocked, notReady, promotable);
		} else if (item.status === "In progress") {
			inProgress.push(item.issueNumber);
		} else if (item.status === "In review") {
			await classifyInReview(client, config, item, reviewable);
		}
	}

	const actionable =
		dispatchable.length > 0 ||
		reviewable.length > 0 ||
		promotable.length > 0 ||
		notReady.length > 0 ||
		needsDecision.length > 0;

	return {
		repo: config.repo,
		dispatchable,
		blocked,
		notReady,
		promotable,
		reviewable,
		inProgress,
		needsDecision,
		milestones: summarizeMilestones(state.items),
		idle: !actionable && inProgress.length === 0,
	};
}

/** Format a plan as a terse human-readable report. */
export function formatForgePlan(plan: ForgePlan): string {
	const list = (items: Array<{ issue: number }>) =>
		items.length > 0 ? items.map((i) => `#${i.issue}`).join(", ") : "(none)";
	const lines = [
		`Forge plan — ${plan.repo}`,
		"",
		`Dispatchable: ${list(plan.dispatchable)}`,
		`Reviewable:   ${list(plan.reviewable)}`,
		`Promotable:   ${list(plan.promotable)}`,
		`Blocked:      ${list(plan.blocked)}`,
		`Not ready:    ${list(plan.notReady)}`,
		`In progress:  ${plan.inProgress.length > 0 ? plan.inProgress.map((n) => `#${n}`).join(", ") : "(none)"}`,
		`Decisions:    ${list(plan.needsDecision)}`,
	];
	for (const m of plan.milestones) {
		const mark = m.complete ? "COMPLETE" : `${m.open} open`;
		lines.push(`Milestone "${m.name}": ${m.done} done, ${mark}`);
	}
	if (plan.idle) {
		lines.push("", "Board is idle — nothing to dispatch, review, or promote.");
	}
	return lines.join("\n");
}
