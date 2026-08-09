import { describe, expect, it } from "bun:test";
import { analyzeFindings, buildRecommendations } from "./retrospect";
import type { BoardItem } from "../github/board";

/** Helper: make a board item. */
function makeItem(number: number, status: string): BoardItem {
	return {
		issueNumber: number,
		title: `Issue ${number}`,
		state: "CLOSED",
		status,
		slice: null,
		milestone: null,
	};
}

/** Helper: telemetry report shape expected by analyzeFindings. */
function makeTelemetryReport(overrides: Partial<{
	totalTurns: number;
	totalToolErrors: number;
	retryTurns: number;
	patterns: Array<{ id: string; description: string }>;
}> = {}) {
	return {
		totalTurns: 0,
		totalToolErrors: 0,
		retryTurns: 0,
		patterns: [],
		...overrides,
	};
}

describe("retrospect analyzeFindings", () => {
	it("reports delivery finding for completed items", () => {
		const items = [makeItem(1, "done"), makeItem(2, "done")];
		const findings = analyzeFindings(items, [], makeTelemetryReport());
		const delivery = findings.find((f) => f.category === "delivery");
		expect(delivery?.description).toContain("2 issue(s)");
	});

	it("reports workflow finding for missing PRs", () => {
		const prData = [
			{ issueNumber: 1, prNumber: null, ciStatus: "none" },
		];
		const findings = analyzeFindings([], prData, makeTelemetryReport());
		const workflow = findings.find((f) => f.category === "workflow");
		expect(workflow?.description).toContain("no linked PR");
	});

	it("reports quality finding for failed CI", () => {
		const prData = [
			{ issueNumber: 1, prNumber: 10, ciStatus: "fail" },
		];
		const findings = analyzeFindings([], prData, makeTelemetryReport());
		const quality = findings.find((f) => f.category === "quality");
		expect(quality?.description).toContain("failing CI");
	});

	it("reports efficiency finding for tool errors", () => {
		const findings = analyzeFindings([], [], makeTelemetryReport({
			totalTurns: 10,
			totalToolErrors: 3,
		}));
		const efficiency = findings.find((f) => f.category === "efficiency");
		expect(efficiency?.description).toContain("3 tool error(s)");
	});

	it("includes telemetry patterns as findings", () => {
		const findings = analyzeFindings([], [], makeTelemetryReport({
			patterns: [
				{ id: "overthinking", description: "High thinking level detected." },
				{ id: "healthy", description: "All good." },
			],
		}));
		expect(findings.some((f) => f.description.includes("High thinking level"))).toBe(true);
		expect(findings.some((f) => f.description.includes("All good."))).toBe(false);
	});

	it("returns no findings for empty input", () => {
		const findings = analyzeFindings([], [], makeTelemetryReport());
		expect(findings).toHaveLength(0);
	});
});

describe("retrospect buildRecommendations", () => {
	it("recommends CI gate check when CI failures found", () => {
		const findings = [
			{ category: "quality" as const, description: "1 PR(s) had failing CI before merge." },
		];
		const recs = buildRecommendations(findings);
		expect(recs.some((r) => r.target === "workflow" && r.description.includes("CI"))).toBe(true);
	});

	it("recommends worker prompt update for missing PRs", () => {
		const findings = [
			{ category: "workflow" as const, description: "2 completed issue(s) had no linked PR." },
		];
		const recs = buildRecommendations(findings);
		expect(recs.some((r) => r.target === "agent_prompt")).toBe(true);
	});

	it("recommends lower thinking level for overthinking", () => {
		const findings = [
			{ category: "efficiency" as const, description: "High thinking level used on 3 turns." },
		];
		const recs = buildRecommendations(findings);
		expect(recs.some((r) => r.target === "thinking_level")).toBe(true);
	});

	it("recommends skill update for tool errors", () => {
		const findings = [
			{ category: "efficiency" as const, description: "5 tool error(s) recorded." },
		];
		const recs = buildRecommendations(findings);
		expect(recs.some((r) => r.target === "skill")).toBe(true);
	});

	it("returns no recommendations for healthy findings", () => {
		const recs = buildRecommendations([]);
		expect(recs).toHaveLength(0);
	});
});
