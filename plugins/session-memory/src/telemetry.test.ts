import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	aggregateTelemetry,
	appendTelemetryRow,
	buildTelemetryRow,
	readUsage,
} from "./telemetry";
import type { TelemetryRow } from "./types";

let dir: string;
let logPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "smem-telemetry-"));
	logPath = join(dir, "turns.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readUsage", () => {
	it("extracts the latest assistant usage from a branch", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", usage: { input: 10, cacheRead: 5, cacheWrite: 1 } } },
			{ type: "message", message: { role: "user", content: "no usage" } },
			{ type: "message", message: { role: "assistant", usage: { input: 42, cacheRead: 24, cacheWrite: 2 } } },
		] as unknown as SessionEntry[];
		expect(readUsage(branch)).toEqual({ input: 42, cacheRead: 24, cacheWrite: 2 });
	});

	it("zeroes missing fields and returns zeros for an empty branch", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", usage: { input: 7 } } },
		] as unknown as SessionEntry[];
		expect(readUsage(branch)).toEqual({ input: 7, cacheRead: 0, cacheWrite: 0 });
		expect(readUsage([])).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("skips non-message entries", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", usage: { input: 3, cacheRead: 1, cacheWrite: 0 } } },
			{ type: "custom", customType: "x", data: {} },
		] as unknown as SessionEntry[];
		expect(readUsage(branch)).toEqual({ input: 3, cacheRead: 1, cacheWrite: 0 });
	});
});

describe("buildTelemetryRow", () => {
	it("assembles the spec §8 row shape", () => {
		const row = buildTelemetryRow(
			"prefix-safe",
			4,
			{ input: 100, cacheRead: 90, cacheWrite: 5 },
			{ injectedChunks: 2, injectedChars: 120, dedupedChunks: 1, recallMs: 12 },
		);
		expect(row.mode).toBe("prefix-safe");
		expect(row.turnNo).toBe(4);
		expect(row.inputTokens).toBe(100);
		expect(row.cacheRead).toBe(90);
		expect(row.cacheWrite).toBe(5);
		expect(row.injectedChunks).toBe(2);
		expect(row.injectedChars).toBe(120);
		expect(row.dedupedChunks).toBe(1);
		expect(row.recallMs).toBe(12);
		expect(new Date(row.ts).getTime()).not.toBeNaN();
	});
});

function telemetryRow(inputTokens: number, cacheRead: number, injectedChunks: number, recallMs: number): TelemetryRow {
	return {
		ts: "2026-08-05T00:00:00.000Z",
		mode: "prefix-safe",
		turnNo: 1,
		inputTokens,
		cacheRead,
		cacheWrite: 0,
		injectedChunks,
		injectedChars: injectedChunks * 50,
		dedupedChunks: 0,
		recallMs,
	};
}

describe("appendTelemetryRow / aggregateTelemetry", () => {
	it("appends JSONL rows and aggregates them", () => {
		appendTelemetryRow(logPath, telemetryRow(100, 80, 2, 10));
		appendTelemetryRow(logPath, telemetryRow(50, 45, 1, 30));
		const agg = aggregateTelemetry(logPath);
		expect(agg.turns).toBe(2);
		expect(agg.totalInput).toBe(150);
		expect(agg.totalCacheRead).toBe(125);
		expect(agg.totalInjectedChunks).toBe(3);
		expect(agg.avgRecallMs).toBe(20);
		// cacheRead / (input + cacheRead)
		expect(agg.cacheHitRatio).toBeCloseTo(125 / 275, 5);
	});

	it("returns an empty aggregate for a missing log", () => {
		const agg = aggregateTelemetry(join(dir, "missing.jsonl"));
		expect(agg.turns).toBe(0);
		expect(agg.cacheHitRatio).toBe(0);
	});

	it("skips malformed JSON lines", () => {
		appendTelemetryRow(logPath, telemetryRow(10, 5, 1, 4));
		appendFileSync(logPath, "not json\n");
		const agg = aggregateTelemetry(logPath);
		expect(agg.turns).toBe(1);
	});
});
