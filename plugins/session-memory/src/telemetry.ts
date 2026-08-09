/**
 * Telemetry — append-only `turns.jsonl` rows + per-session aggregates (spec §8).
 *
 * Cache usage (`input`/`cacheRead`/`cacheWrite`) is read from the latest
 * assistant message in the session branch. Each `turn_end` appends one row; the
 * A/B comparison protocol compares `cacheRead / inputTokens` across modes.
 */

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { RecallMode, TelemetryRow } from "./types";

/** Cache-usage snapshot extracted from a session branch. */
export interface UsageSnapshot {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Per-session telemetry aggregates surfaced by `smem_stats`. */
export interface TelemetryAggregate {
	turns: number;
	totalInput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalInjectedChunks: number;
	totalDedupedChunks: number;
	avgRecallMs: number;
	/** cacheRead / (input + cacheRead) — the prefix-safe headline metric. */
	cacheHitRatio: number;
}

/** Extract the latest assistant usage from a session branch (zeros if none). */
export function readUsage(branch: readonly SessionEntry[]): UsageSnapshot {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const usage = extractUsage((entry as { message: unknown }).message);
		if (usage) return usage;
	}
	return { input: 0, cacheRead: 0, cacheWrite: 0 };
}
/** Metrics carried from the recall package into a telemetry row. */
export interface RecallMetrics {
	injectedChunks: number;
	injectedChars: number;
	dedupedChunks: number;
	recallMs: number;
}

/** Build a telemetry row from its components. */
export function buildTelemetryRow(
	mode: RecallMode,
	turnNo: number,
	usage: UsageSnapshot,
	metrics: RecallMetrics,
): TelemetryRow {
	return {
		ts: new Date().toISOString(),
		mode,
		turnNo,
		inputTokens: usage.input,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		injectedChunks: metrics.injectedChunks,
		injectedChars: metrics.injectedChars,
		dedupedChunks: metrics.dedupedChunks,
		recallMs: metrics.recallMs,
	};
}

/** Append one telemetry row to the JSONL log. */
export function appendTelemetryRow(path: string, row: TelemetryRow): void {
	appendFileSync(path, `${JSON.stringify(row)}\n`, "utf-8");
}

/** Aggregate every row in the telemetry log (empty when absent). */
export function aggregateTelemetry(path: string): TelemetryAggregate {
	const rows = readRows(path);
	if (rows.length === 0) return emptyAggregate();
	const sums = rows.reduce(addRow, zeroedSums());
	return {
		turns: rows.length,
		totalInput: sums.input,
		totalCacheRead: sums.cacheRead,
		totalCacheWrite: sums.cacheWrite,
		totalInjectedChunks: sums.injectedChunks,
		totalDedupedChunks: sums.dedupedChunks,
		avgRecallMs: rows.length === 0 ? 0 : Math.round(sums.recallMs / rows.length),
		cacheHitRatio: ratio(sums.cacheRead, sums.input + sums.cacheRead),
	};
}

/** Pull a message's usage when it is an assistant message carrying one. */
function extractUsage(message: unknown): UsageSnapshot | null {
	if (typeof message !== "object" || message === null) return null;
	const m = message as { role?: unknown; usage?: unknown };
	if (m.role !== "assistant" || typeof m.usage !== "object" || m.usage === null) return null;
	const u = m.usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
	return {
		input: toNumber(u.input),
		cacheRead: toNumber(u.cacheRead),
		cacheWrite: toNumber(u.cacheWrite),
	};
}

function toNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Read + parse every JSON line from the telemetry log. */
function readRows(path: string): TelemetryRow[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf-8");
	return text
		.split("\n")
		.filter(line => line.trim().length > 0)
		.flatMap(line => parseRow(line));
}

function parseRow(line: string): TelemetryRow[] {
	try {
		return [JSON.parse(line) as TelemetryRow];
	} catch {
		return [];
	}
}

interface Sums {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	injectedChunks: number;
	dedupedChunks: number;
	recallMs: number;
}

function zeroedSums(): Sums {
	return { input: 0, cacheRead: 0, cacheWrite: 0, injectedChunks: 0, dedupedChunks: 0, recallMs: 0 };
}

function addRow(sums: Sums, row: TelemetryRow): Sums {
	return {
		input: sums.input + row.inputTokens,
		cacheRead: sums.cacheRead + row.cacheRead,
		cacheWrite: sums.cacheWrite + row.cacheWrite,
		injectedChunks: sums.injectedChunks + row.injectedChunks,
		dedupedChunks: sums.dedupedChunks + row.dedupedChunks,
		recallMs: sums.recallMs + row.recallMs,
	};
}

function emptyAggregate(): TelemetryAggregate {
	return {
		turns: 0,
		totalInput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalInjectedChunks: 0,
		totalDedupedChunks: 0,
		avgRecallMs: 0,
		cacheHitRatio: 0,
	};
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}
