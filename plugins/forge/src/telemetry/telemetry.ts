/**
 * Thinking-level telemetry: turn_end handler, analysis, and report formatting.
 *
 * The handler is created by {@link createTurnEndHandler} and registered via
 * `pi.on("turn_end", handler)`. It records a {@link ThinkingTelemetryEntry}
 * per turn. Analysis and formatting are pure functions, separately testable.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { TurnEndEvent } from "@oh-my-pi/pi-coding-agent";
import type {
	ThinkingTelemetryEntry,
	TelemetryPattern,
	TelemetryReport,
} from "./types";
import { TELEMETRY_CUSTOM_TYPE } from "./types";
/** Thresholds for pattern detection. */
const OVERTHINKING_MAX_TOOLS = 2;
const OVERTHINKING_MIN_LEVELS = new Set(["high", "xhigh", "max"]);
const UNDERTHINKING_HIGH_LEVELS = new Set(["off", "minimal", "low"]);
const UNDERTHINKING_MIN_RETRIES = 2;
const HIGH_RETRY_RATE_THRESHOLD = 0.3;

/**
 * Create a `turn_end` handler that records thinking telemetry.
 * Only call when `self_improvement` is enabled.
 */
export function createTurnEndHandler(
	pi: ExtensionAPI,
): (event: TurnEndEvent) => void {
	return (event: TurnEndEvent): void => {
		const entry = buildEntry(event, pi.getThinkingLevel());
		pi.appendEntry(TELEMETRY_CUSTOM_TYPE, entry);
	};
}

/** Build a telemetry entry from a turn_end event. Pure, testable. */
export function buildEntry(
	event: TurnEndEvent,
	thinkingLevel: string | undefined,
): ThinkingTelemetryEntry {
	return {
		ts: Date.now(),
		turnIndex: event.turnIndex,
		thinkingLevel,
		toolCalls: event.toolResults.length,
		toolErrors: countErrors(event),
		hadRetry: false,
	};
}

/** Count tool errors from a turn_end event. */
function countErrors(event: TurnEndEvent): number {
	let count = 0;
	for (const result of event.toolResults) {
		const content = result.content;
		if (
			typeof content === "object" && content !== null &&
			"is_error" in content && content.is_error === true
		) {
			count++;
		}
	}
	return count;
}

/** Extract telemetry entries from session branch entries. */
export function extractTelemetryEntries(
	branch: Array<{ type: string; customType?: string; data?: unknown }>,
): ThinkingTelemetryEntry[] {
	const entries: ThinkingTelemetryEntry[] = [];
	for (const entry of branch) {
		if (
			entry.type === "custom" &&
			entry.customType === TELEMETRY_CUSTOM_TYPE &&
			entry.data !== undefined
		) {
			entries.push(entry.data as ThinkingTelemetryEntry);
		}
	}
	return entries;
}

/** Analyze telemetry entries and detect patterns. Pure, testable. */
export function analyzeTelemetry(
	entries: ThinkingTelemetryEntry[],
): TelemetryReport {
	const distribution: Record<string, number> = {};
	let totalToolCalls = 0;
	let totalToolErrors = 0;
	let retryTurns = 0;

	for (const entry of entries) {
		const level = entry.thinkingLevel ?? "unknown";
		distribution[level] = (distribution[level] ?? 0) + 1;
		totalToolCalls += entry.toolCalls;
		totalToolErrors += entry.toolErrors;
		if (entry.hadRetry) retryTurns++;
	}

	const patterns = detectPatterns(entries);

	return {
		totalTurns: entries.length,
		thinkingDistribution: distribution,
		totalToolCalls,
		totalToolErrors,
		retryTurns,
		patterns,
	};
}

/** Detect overthinking / underthinking patterns from entries. */
function detectPatterns(
	entries: ThinkingTelemetryEntry[],
): TelemetryPattern[] {
	const patterns: TelemetryPattern[] = [];
	const retryTurns = entries.filter((e) => e.hadRetry).length;

	const overthinkingTurns = entries.filter(
		(e) =>
			e.thinkingLevel !== undefined &&
			OVERTHINKING_MIN_LEVELS.has(e.thinkingLevel) &&
			e.toolCalls <= OVERTHINKING_MAX_TOOLS &&
			e.toolErrors === 0,
	);

	if (overthinkingTurns.length > 0) {
		patterns.push({
			id: "overthinking",
			description: `High thinking level used on ${overthinkingTurns.length} turn(s) with few tool calls and no errors — consider lowering thinking level for simpler tasks.`,
			turns: overthinkingTurns.map((e) => e.turnIndex),
			severity: "warning",
		});
	}

	const underthinkingTurns = entries.filter(
		(e) =>
			e.thinkingLevel !== undefined &&
			UNDERTHINKING_HIGH_LEVELS.has(e.thinkingLevel) &&
			e.hadRetry,
	);

	if (underthinkingTurns.length >= UNDERTHINKING_MIN_RETRIES) {
		patterns.push({
			id: "underthinking",
			description: `Low thinking level combined with retries on ${underthinkingTurns.length} turn(s) — consider raising thinking level for complex tasks.`,
			turns: underthinkingTurns.map((e) => e.turnIndex),
			severity: "warning",
		});
	}

	const retryRate = entries.length > 0 ? retryTurns / entries.length : 0;
	if (retryRate > HIGH_RETRY_RATE_THRESHOLD) {
		patterns.push({
			id: "high_retry_rate",
			description: `${retryTurns} of ${entries.length} turns required retries (${Math.round(retryRate * 100)}%) — investigate recurring failures.`,
			turns: entries.filter((e) => e.hadRetry).map((e) => e.turnIndex),
			severity: "critical",
		});
	}

	if (patterns.length === 0 && entries.length > 0) {
		patterns.push({
			id: "healthy",
			description: "No concerning patterns detected — thinking levels and retry rates are within healthy ranges.",
			turns: [],
			severity: "info",
		});
	}

	return patterns;
}

/** Format a telemetry report as a human-readable string. */
export function formatTelemetryReport(report: TelemetryReport): string {
	const lines: string[] = [];
	lines.push("=== Forge Thinking Telemetry ===");
	lines.push("");
	lines.push(`Turns analyzed: ${report.totalTurns}`);
	lines.push(`Tool calls: ${report.totalToolCalls} (${report.totalToolErrors} errors)`);
	lines.push(`Retry turns: ${report.retryTurns}`);
	lines.push("");

	if (report.totalTurns === 0) {
		lines.push("No telemetry data yet. Use forge with self_improvement enabled to collect.");
		return lines.join("\n");
	}

	lines.push("Thinking level distribution:");
	for (const [level, count] of Object.entries(report.thinkingDistribution)) {
		const pct = Math.round((count / report.totalTurns) * 100);
		lines.push(`  ${level}: ${count} turns (${pct}%)`);
	}
	lines.push("");

	lines.push("Patterns:");
	for (const pattern of report.patterns) {
		const icon = pattern.severity === "critical" ? "⚠" :
			pattern.severity === "warning" ? "!" : "✓";
		lines.push(`  [${icon}] ${pattern.description}`);
	}

	return lines.join("\n");
}
