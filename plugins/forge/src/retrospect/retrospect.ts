/**
 * Retrospective analysis for forge v2.
 *
 * Combines GitHub history (merged PRs, issue outcomes, CI status) with
 * session telemetry (thinking patterns, tool errors) into a structured
 * report with findings and actionable recommendations.
 *
 * `generateRetrospect` is the entry point; `analyzeFindings` and
 * `buildRecommendations` are pure functions, separately testable.
 */

import type { SingleProjectConfig } from "../config/forge-toml";
import type { ForgeGitHubClient } from "../github/client";
import { getBoardState, type BoardItem } from "../github/board";
import { getLinkedPr } from "../github/issue";
import { getCiStatus } from "../github/pr";
import { analyzeTelemetry } from "../telemetry/telemetry";
import type { ThinkingTelemetryEntry } from "../telemetry/types";

/** Input for retrospect generation. */
export interface RetrospectInput {
	/** Optional milestone number to filter by. */
	milestoneNumber?: number;
	/** Session branch entries from sessionManager.getBranch(). */
	sessionBranch: Array<{ type: string; customType?: string; data?: unknown }>;
	/** Pre-extracted telemetry entries (from sessionBranch). */
	telemetryEntries: ThinkingTelemetryEntry[];
}

/** A single finding from the retrospective. */
export interface RetrospectFinding {
	/** Category: which aspect of the delivery this relates to. */
	category: "delivery" | "quality" | "efficiency" | "workflow";
	/** What was observed. */
	description: string;
}

/** A recommendation derived from findings. */
export interface RetrospectRecommendation {
	/** Target: what to change. */
	target: "agent_prompt" | "skill" | "spec" | "workflow" | "thinking_level";
	/** What to change. */
	description: string;
}

/** The full retrospective report. */
export interface RetrospectReport {
	/** Human-readable summary. */
	summary: string;
	/** Observed findings. */
	findings: string[];
	/** Actionable recommendations. */
	recommendations: string[];
}

/**
 * Generate a retrospective by gathering GitHub + telemetry data.
 */
export async function generateRetrospect(
	client: ForgeGitHubClient,
	config: SingleProjectConfig,
	input: RetrospectInput,
): Promise<RetrospectReport> {
	const state = await getBoardState(client, config);
	const doneItems = filterDoneItems(state.items, input.milestoneNumber);
	const prData = await gatherPrData(client, config.repo, doneItems);

	const telemetryReport = analyzeTelemetry(input.telemetryEntries);
	const findings = analyzeFindings(doneItems, prData, telemetryReport);
	const recommendations = buildRecommendations(findings);

	return {
		summary: buildSummary(doneItems, prData, telemetryReport),
		findings: findings.map((f) => f.description),
		recommendations: recommendations.map((r) => r.description),
	};
}

/** PR data gathered for retrospective. */
interface PrData {
	issueNumber: number;
	prNumber: number | null;
	ciStatus: string;
}

/** Filter board items to Done, optionally by milestone. */
function filterDoneItems(items: BoardItem[], milestoneNum?: number): BoardItem[] {
	return items.filter((item) => {
		if (item.status !== "done") return false;
		if (milestoneNum !== undefined && item.milestone !== null) {
			return true;
		}
		return true;
	});
}

/** Gather PR + CI data for done items. Sequential (rate-limit safe). */
async function gatherPrData(
	client: ForgeGitHubClient,
	repo: string,
	items: BoardItem[],
): Promise<PrData[]> {
	const results: PrData[] = [];
	for (const item of items) {
		const prNumber = await getLinkedPr(client, repo, item.issueNumber);
		const ciStatus = prNumber !== null
			? await getCiStatus(client, repo, prNumber)
			: "none";
		results.push({ issueNumber: item.issueNumber, prNumber, ciStatus });
	}
	return results;
}

/** Analyze gathered data into structured findings. Pure, testable. */
export function analyzeFindings(
	doneItems: BoardItem[],
	prData: PrData[],
	telemetryReport: {
		totalTurns: number;
		totalToolErrors: number;
		retryTurns: number;
		patterns: Array<{ id: string; description: string }>;
	},
): RetrospectFinding[] {
	const findings: RetrospectFinding[] = [];

	if (doneItems.length > 0) {
		findings.push({
			category: "delivery",
			description: `${doneItems.length} issue(s) completed this period.`,
		});
	}

	const noPr = prData.filter((p) => p.prNumber === null);
	if (noPr.length > 0) {
		findings.push({
			category: "workflow",
			description: `${noPr.length} completed issue(s) had no linked PR — verify the work was merged.`,
		});
	}

	const ciFailed = prData.filter((p) => p.ciStatus === "fail");
	if (ciFailed.length > 0) {
		findings.push({
			category: "quality",
			description: `${ciFailed.length} PR(s) had failing CI before merge — gate enforcement may need tightening.`,
		});
	}

	if (telemetryReport.totalToolErrors > 0) {
		findings.push({
			category: "efficiency",
			description: `${telemetryReport.totalToolErrors} tool error(s) recorded across ${telemetryReport.totalTurns} turns.`,
		});
	}

	for (const pattern of telemetryReport.patterns) {
		if (pattern.id === "healthy") continue;
		findings.push({
			category: "efficiency",
			description: pattern.description,
		});
	}

	return findings;
}

/** Derive recommendations from findings. Pure, testable. */
export function buildRecommendations(
	findings: RetrospectFinding[],
): RetrospectRecommendation[] {
	const recs: RetrospectRecommendation[] = [];

	const ciFailures = findings.some(
		(f) => f.category === "quality" && f.description.includes("failing CI"),
	);
	if (ciFailures) {
		recs.push({
			target: "workflow",
			description: "Add a pre-merge CI status check to the forge gate — block promotion when CI is failing.",
		});
	}

	const missingPrs = findings.some(
		(f) => f.category === "workflow" && f.description.includes("no linked PR"),
	);
	if (missingPrs) {
		recs.push({
			target: "agent_prompt",
			description: "Update worker prompt to require opening a draft PR before yielding — add a checklist item.",
		});
	}

	const overthinking = findings.some(
		(f) => f.description.includes("High thinking level"),
	);
	if (overthinking) {
		recs.push({
			target: "thinking_level",
			description: "Consider setting a lower default thinking level for simple tasks to reduce token waste.",
		});
	}

	const underthinking = findings.some(
		(f) => f.description.includes("Low thinking level"),
	);
	if (underthinking) {
		recs.push({
			target: "thinking_level",
			description: "Consider raising thinking level for complex tasks that required retries.",
		});
	}

	const toolErrors = findings.some(
		(f) => f.category === "efficiency" && f.description.includes("tool error"),
	);
	if (toolErrors) {
		recs.push({
			target: "skill",
			description: "Review tool error patterns and add guidance to agent skills to avoid common pitfalls.",
		});
	}

	return recs;
}

/** Build a human-readable summary line. */
function buildSummary(
	doneItems: BoardItem[],
	prData: PrData[],
	telemetryReport: { totalTurns: number },
): string {
	const prCount = prData.filter((p) => p.prNumber !== null).length;
	return `${doneItems.length} issues completed, ${prCount} PRs linked, ${telemetryReport.totalTurns} turns of telemetry analyzed.`;
}
