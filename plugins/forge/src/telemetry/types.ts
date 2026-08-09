/**
 * Telemetry types for forge v2 thinking-level tracking.
 *
 * One {@link ThinkingTelemetryEntry} is recorded per `turn_end` event via
 * `pi.appendEntry("com.mjaric.forge.telemetry", entry)`. They persist in the
 * session journal and are reconstructed on reload.
 */

/** Severity of a detected pattern. */
export type PatternSeverity = "info" | "warning" | "critical";

/** A single detected telemetry pattern (overthinking, underthinking, etc.). */
export interface TelemetryPattern {
	/** Machine-readable pattern id. */
	id: "overthinking" | "underthinking" | "high_retry_rate" | "healthy";
	/** Human-readable description. */
	description: string;
	/** Affected turn indices. */
	turns: number[];
	/** How serious this pattern is. */
	severity: PatternSeverity;
}

/** Per-turn telemetry record. Stored as CustomEntry data. */
export interface ThinkingTelemetryEntry {
	/** Unix timestamp (ms). */
	ts: number;
	/** Turn index from TurnEndEvent. */
	turnIndex: number;
	/** Thinking level at turn end. */
	thinkingLevel: string | undefined;
	/** Number of tool calls in this turn. */
	toolCalls: number;
	/** Number of tool errors in this turn. */
	toolErrors: number;
	/** Whether any auto-retry occurred during this turn. */
	hadRetry: boolean;
}

/** Result of analyzing a collection of telemetry entries. */
export interface TelemetryReport {
	/** Total turns analyzed. */
	totalTurns: number;
	/** Distribution of thinking levels used. */
	thinkingDistribution: Record<string, number>;
	/** Total tool calls across all turns. */
	totalToolCalls: number;
	/** Total tool errors across all turns. */
	totalToolErrors: number;
	/** Turns that had auto-retries. */
	retryTurns: number;
	/** Detected patterns. */
	patterns: TelemetryPattern[];
}

/** Custom entry type identifier for forge telemetry. */
export const TELEMETRY_CUSTOM_TYPE = "com.mjaric.forge.telemetry";
