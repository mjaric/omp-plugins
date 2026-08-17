import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assembleReport,
	checkConfigExists,
	checkGhAuth,
	checkBinary,
	extractGateBinaries,
	checkBoardExists,
	checkBoardFieldId,
	checkBoardOptions,
	checkProjectOwnership,
	findOptionMismatches,
	formatDoctorReport,
	type BoardFieldInfo,
} from "./doctor";
import type { SingleProjectConfig, StatusOptions } from "../config/forge-toml";
import type { DoctorCheck } from "./doctor";

/** Helper: make a minimal config. */
function makeConfig(overrides: Partial<SingleProjectConfig> = {}): SingleProjectConfig {
	return {
		repo: "mjaric/smith",
		projectId: "PVT_test",
		statusFieldId: "FID_test",
		statusOptions: {
			backlog: "opt_backlog",
			ready: "opt_ready",
			inProgress: "opt_inprogress",
			inReview: "opt_inreview",
			done: "opt_done",
		},
		gate: ["cargo test"],
		...overrides,
	};
}

/** Helper: make matching board field info. */
function makeMatchingFieldInfo(): BoardFieldInfo {
	return {
		fieldId: "FID_test",
		options: [
			{ id: "opt_backlog", name: "Backlog" },
			{ id: "opt_ready", name: "Ready" },
			{ id: "opt_inprogress", name: "In Progress" },
			{ id: "opt_inreview", name: "In Review" },
			{ id: "opt_done", name: "Done" },
		],
	};
}
describe("doctor checkConfigExists", () => {
	it("returns ok when file exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "forge-doctor-"));
		writeFileSync(join(dir, ".forge.toml"), "repo = \"test\"");
		const check = checkConfigExists(dir);
		expect(check.severity).toBe("ok");
		expect(check.id).toBe("config-exists");
	});

	it("returns error when file missing", () => {
		const check = checkConfigExists("/nonexistent/path/xyz");
		expect(check.severity).toBe("error");
		expect(check.detail).toContain("setup");
	});
});

describe("doctor checkGhAuth", () => {
	it("returns a check with correct id", () => {
		const check = checkGhAuth();
		expect(check.id).toBe("gh-auth");
		expect(check.category).toBe("local");
		expect(["ok", "error"]).toContain(check.severity);
	});
});

describe("doctor checkBinary", () => {
	it("returns ok when binary is available", () => {
		const check = checkBinary("cargo", true);
		expect(check.severity).toBe("ok");
		expect(check.id).toBe("binary-cargo");
	});

	it("returns error when binary is missing", () => {
		const check = checkBinary("nonexistent-tool", false);
		expect(check.severity).toBe("error");
		expect(check.detail).toContain("not found");
	});
});

describe("doctor extractGateBinaries", () => {
	it("extracts simple command names", () => {
		const bins = extractGateBinaries(["cargo test", "cargo clippy", "vitest"]);
		expect(bins).toContain("cargo");
		expect(bins).toContain("vitest");
		expect(bins).toHaveLength(2);
	});

	it("resolves bunx to the actual tool name", () => {
		const bins = extractGateBinaries(["bunx vitest", "bunx oxlint", "cargo test"]);
		expect(bins).toContain("vitest");
		expect(bins).toContain("oxlint");
		expect(bins).toContain("cargo");
	});

	it("handles empty gate", () => {
		expect(extractGateBinaries([])).toHaveLength(0);
	});

	it("deduplicates binaries", () => {
		const bins = extractGateBinaries(["cargo test", "cargo clippy"]);
		expect(bins).toHaveLength(1);
	});
});

describe("doctor checkBoardExists", () => {
	it("returns ok when field info is available", () => {
		const config = makeConfig();
		const check = checkBoardExists(makeMatchingFieldInfo(), config);
		expect(check.severity).toBe("ok");
	});

	it("returns error when board is null", () => {
		const config = makeConfig();
		const check = checkBoardExists(null, config);
		expect(check.severity).toBe("error");
	});
});

describe("doctor checkBoardFieldId", () => {
	it("returns ok when field IDs match", () => {
		const config = makeConfig();
		const check = checkBoardFieldId(makeMatchingFieldInfo(), config);
		expect(check.severity).toBe("ok");
		expect(check.fixable).toBe(false);
	});

	it("returns warning when field IDs differ", () => {
		const config = makeConfig({ statusFieldId: "OLD_field_id" });
		const fieldInfo: BoardFieldInfo = { fieldId: "NEW_field_id", options: [] };
		const check = checkBoardFieldId(fieldInfo, config);
		expect(check.severity).toBe("warning");
		expect(check.fixable).toBe(true);
	});

	it("returns error when board not accessible", () => {
		const config = makeConfig();
		const check = checkBoardFieldId(null, config);
		expect(check.severity).toBe("error");
	});
});

describe("doctor findOptionMismatches", () => {
	it("returns empty when all options match", () => {
		const config = makeConfig();
		const fieldInfo = makeMatchingFieldInfo();
		expect(findOptionMismatches(config.statusOptions, fieldInfo)).toHaveLength(0);
	});

	it("detects changed option IDs", () => {
		const options: StatusOptions = {
			backlog: "OLD_backlog",
			ready: "opt_ready",
			inProgress: "opt_inprogress",
			inReview: "opt_inreview",
			done: "opt_done",
		};
		const fieldInfo = makeMatchingFieldInfo();
		const mismatches = findOptionMismatches(options, fieldInfo);
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0]).toContain("backlog");
	});

	it("normalizes option names (spaces, case)", () => {
		const options: StatusOptions = {
			backlog: "new_id_1",
			ready: "new_id_2",
			inProgress: "new_id_3",
			inReview: "new_id_4",
			done: "new_id_5",
		};
		const fieldInfo: BoardFieldInfo = {
			fieldId: "FID",
			options: [
				{ id: "new_id_1", name: "BACKLOG" },
				{ id: "new_id_2", name: "READY" },
				{ id: "new_id_3", name: "In-Progress" },
				{ id: "new_id_4", name: "In_Review" },
				{ id: "new_id_5", name: "DONE" },
			],
		};
		expect(findOptionMismatches(options, fieldInfo)).toHaveLength(0);
	});
});

describe("doctor checkBoardOptions", () => {
	it("returns ok when options match", () => {
		const config = makeConfig();
		const check = checkBoardOptions(makeMatchingFieldInfo(), config);
		expect(check.severity).toBe("ok");
	});

	it("returns warning with mismatch detail when options differ", () => {
		const config = makeConfig({
			statusOptions: {
				backlog: "OLD",
				ready: "opt_ready",
				inProgress: "opt_inprogress",
				inReview: "opt_inreview",
				done: "opt_done",
			},
		});
		const check = checkBoardOptions(makeMatchingFieldInfo(), config);
		expect(check.severity).toBe("warning");
		expect(check.fixable).toBe(true);
		expect(check.detail).toContain("backlog");
	});
});

describe("doctor assembleReport", () => {
	it("counts severities correctly", () => {
		const checks: DoctorCheck[] = [
			{ id: "a", description: "A", severity: "ok", category: "local", detail: "", fixable: false },
			{ id: "b", description: "B", severity: "warning", category: "github", detail: "w", fixable: false },
			{ id: "c", description: "C", severity: "error", category: "local", detail: "e", fixable: false },
			{ id: "d", description: "D", severity: "ok", category: "config", detail: "", fixable: false },
		];
		const report = assembleReport(checks);
		expect(report.passed).toBe(2);
		expect(report.warnings).toBe(1);
		expect(report.errors).toBe(1);
		expect(report.checks).toHaveLength(4);
	});
});

describe("doctor formatDoctorReport", () => {
	it("includes all checks with icons", () => {
		const report = assembleReport([
			{ id: "ok-check", description: "Good thing", severity: "ok", category: "local", detail: "", fixable: false },
			{ id: "err-check", description: "Bad thing", severity: "error", category: "local", detail: "It's broken", fixable: false },
		]);
		const text = formatDoctorReport(report);
		expect(text).toContain("✓");
		expect(text).toContain("✗");
		expect(text).toContain("Good thing");
		expect(text).toContain("Bad thing");
		expect(text).toContain("It's broken");
		expect(text).toContain("1 passed");
		expect(text).toContain("1 errors");
	});

	it("shows fixable marker for fixable issues", () => {
		const report = assembleReport([
			{ id: "fixable", description: "Can fix", severity: "warning", category: "github", detail: "Mismatch", fixable: true },
		]);
		const text = formatDoctorReport(report);
		expect(text).toContain("Auto-fixable");
	});
});

describe("doctor checkProjectOwnership", () => {
	it("ok when the board owner matches the repo owner", () => {
		const check = checkProjectOwnership(
			{ login: "mjaric", kind: "user" },
			makeConfig({ projectId: "PVT_test" }),
		);
		expect(check.id).toBe("project-ownership");
		expect(check.category).toBe("github");
		expect(check.severity).toBe("ok");
		expect(check.detail).toContain("mjaric");
		expect(check.detail).toContain("personal");
	});

	it("error when the board owner cannot be read", () => {
		const check = checkProjectOwnership(null, makeConfig({ projectId: "PVT_test" }));
		expect(check.severity).toBe("error");
		expect(check.detail).toContain("Cannot read owner of PVT_test");
	});

	it("error when the board owner differs from the repo owner", () => {
		const check = checkProjectOwnership(
			{ login: "DreamforgeRS", kind: "org" },
			makeConfig({ projectId: "PVT_test" }),
		);
		expect(check.severity).toBe("error");
		expect(check.detail).toContain("DreamforgeRS");
		expect(check.detail).toContain("organization");
		expect(check.detail).toContain("mjaric/smith");
		expect(check.detail).toContain("/forge setup");
	});
});
