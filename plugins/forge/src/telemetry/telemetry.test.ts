import { describe, expect, it } from "bun:test";
import {
	analyzeTelemetry,
	buildEntry,
	extractTelemetryEntries,
	formatTelemetryReport,
} from "./telemetry";
import { TELEMETRY_CUSTOM_TYPE } from "./types";
import type { ThinkingTelemetryEntry, TelemetryReport } from "./types";

/** Helper: build a minimal TurnEndEvent-like object. */
function makeTurnEnd(
	turnIndex: number,
	toolResultCount: number,
	errorCount = 0,
): {
	turnIndex: number;
	message: { role: string };
	toolResults: Array<{ content: Record<string, unknown> }>;
} {
	const results: Array<{ content: Record<string, unknown> }> = [];
	for (let i = 0; i < toolResultCount; i++) {
		results.push({
			content: i < errorCount ? { is_error: true } : { text: "ok" },
		});
	}
	return {
		turnIndex,
		message: { role: "assistant" },
		toolResults: results,
	};
}

describe("telemetry buildEntry", () => {
	it("records turn index and thinking level", () => {
		const event = makeTurnEnd(5, 3);
		const entry = buildEntry(event as never, "high");
		expect(entry.turnIndex).toBe(5);
		expect(entry.thinkingLevel).toBe("high");
		expect(entry.toolCalls).toBe(3);
		expect(entry.toolErrors).toBe(0);
	});

	it("counts tool errors correctly", () => {
		const event = makeTurnEnd(1, 4, 2);
		const entry = buildEntry(event as never, "medium");
		expect(entry.toolCalls).toBe(4);
		expect(entry.toolErrors).toBe(2);
	});

	it("handles undefined thinking level", () => {
		const event = makeTurnEnd(0, 1);
		const entry = buildEntry(event as never, undefined);
		expect(entry.thinkingLevel).toBeUndefined();
	});
});

describe("telemetry extractTelemetryEntries", () => {
	it("extracts only forge telemetry custom entries", () => {
		const branch: Array<{ type: string; customType?: string; data?: unknown }> = [
			{ type: "custom", customType: TELEMETRY_CUSTOM_TYPE, data: { turnIndex: 0 } },
			{ type: "custom", customType: "other.extension", data: { foo: 1 } },
			{ type: "custom", customType: TELEMETRY_CUSTOM_TYPE, data: { turnIndex: 1 } },
			{ type: "message" },
		];
		const entries = extractTelemetryEntries(branch);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.turnIndex).toBe(0);
		expect(entries[1]?.turnIndex).toBe(1);
	});

	it("returns empty for no telemetry entries", () => {
		const branch: Array<{ type: string; customType?: string; data?: unknown }> = [
			{ type: "custom", customType: "other", data: {} },
			{ type: "message" },
		];
		expect(extractTelemetryEntries(branch)).toHaveLength(0);
	});
});

describe("telemetry analyzeTelemetry", () => {
	it("reports healthy when no patterns detected", () => {
		const entries: ThinkingTelemetryEntry[] = [
			{ ts: 1, turnIndex: 0, thinkingLevel: "medium", toolCalls: 5, toolErrors: 0, hadRetry: false },
			{ ts: 2, turnIndex: 1, thinkingLevel: "medium", toolCalls: 3, toolErrors: 0, hadRetry: false },
		];
		const report = analyzeTelemetry(entries);
		expect(report.totalTurns).toBe(2);
		expect(report.patterns).toHaveLength(1);
		expect(report.patterns[0]?.id).toBe("healthy");
	});

	it("detects overthinking pattern", () => {
		const entries: ThinkingTelemetryEntry[] = [
			{ ts: 1, turnIndex: 0, thinkingLevel: "max", toolCalls: 1, toolErrors: 0, hadRetry: false },
			{ ts: 2, turnIndex: 1, thinkingLevel: "xhigh", toolCalls: 0, toolErrors: 0, hadRetry: false },
		];
		const report = analyzeTelemetry(entries);
		const overthinking = report.patterns.find((p) => p.id === "overthinking");
		expect(overthinking).toBeDefined();
		expect(overthinking?.turns).toEqual([0, 1]);
		expect(overthinking?.severity).toBe("warning");
	});

	it("detects underthinking pattern with retries", () => {
		const entries: ThinkingTelemetryEntry[] = [
			{ ts: 1, turnIndex: 0, thinkingLevel: "off", toolCalls: 5, toolErrors: 2, hadRetry: true },
			{ ts: 2, turnIndex: 1, thinkingLevel: "low", toolCalls: 3, toolErrors: 1, hadRetry: true },
		];
		const report = analyzeTelemetry(entries);
		const underthinking = report.patterns.find((p) => p.id === "underthinking");
		expect(underthinking).toBeDefined();
	});

	it("detects high retry rate pattern", () => {
		const entries: ThinkingTelemetryEntry[] = [
			{ ts: 1, turnIndex: 0, thinkingLevel: "medium", toolCalls: 2, toolErrors: 0, hadRetry: true },
			{ ts: 2, turnIndex: 1, thinkingLevel: "medium", toolCalls: 3, toolErrors: 0, hadRetry: false },
			{ ts: 3, turnIndex: 2, thinkingLevel: "medium", toolCalls: 1, toolErrors: 0, hadRetry: true },
		];
		const report = analyzeTelemetry(entries);
		const highRetry = report.patterns.find((p) => p.id === "high_retry_rate");
		expect(highRetry).toBeDefined();
		expect(highRetry?.severity).toBe("critical");
	});

	it("computes thinking distribution correctly", () => {
		const entries: ThinkingTelemetryEntry[] = [
			{ ts: 1, turnIndex: 0, thinkingLevel: "high", toolCalls: 2, toolErrors: 0, hadRetry: false },
			{ ts: 2, turnIndex: 1, thinkingLevel: "high", toolCalls: 1, toolErrors: 0, hadRetry: false },
			{ ts: 3, turnIndex: 2, thinkingLevel: "low", toolCalls: 3, toolErrors: 0, hadRetry: false },
		];
		const report = analyzeTelemetry(entries);
		expect(report.thinkingDistribution["high"]).toBe(2);
		expect(report.thinkingDistribution["low"]).toBe(1);
	});

	it("handles empty entries", () => {
		const report = analyzeTelemetry([]);
		expect(report.totalTurns).toBe(0);
		expect(report.patterns).toHaveLength(0);
	});
});

describe("telemetry formatTelemetryReport", () => {
	it("shows no-data message for empty report", () => {
		const report: TelemetryReport = {
			totalTurns: 0,
			thinkingDistribution: {},
			totalToolCalls: 0,
			totalToolErrors: 0,
			retryTurns: 0,
			patterns: [],
		};
		const text = formatTelemetryReport(report);
		expect(text).toContain("No telemetry data yet");
	});

	it("includes distribution and patterns for non-empty report", () => {
		const report: TelemetryReport = {
			totalTurns: 3,
			thinkingDistribution: { medium: 2, high: 1 },
			totalToolCalls: 10,
			totalToolErrors: 1,
			retryTurns: 0,
			patterns: [{
				id: "healthy",
				description: "All good.",
				turns: [],
				severity: "info",
			}],
		};
		const text = formatTelemetryReport(report);
		expect(text).toContain("Turns analyzed: 3");
		expect(text).toContain("medium: 2 turns");
		expect(text).toContain("high: 1 turns");
		expect(text).toContain("All good.");
	});
});
