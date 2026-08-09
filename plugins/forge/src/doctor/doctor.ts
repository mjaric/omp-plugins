/**
 * /forge doctor — environment + board sync diagnostics.
 *
 * Two scenarios:
 * 1. **New machine**: .forge.toml is in the repo but local tooling/auth
 *    is missing (gh CLI, auth token, gate tools like cargo/bun).
 * 2. **Plugin update / board drift**: GitHub board may have changed
 *    (fields renamed, option IDs rotated) or new config fields added.
 *
 * Each check is a pure function returning a {@link DoctorCheck} result.
 * Fixes are applied one at a time with `ui.confirm` per the user's
 * chosen behavior. All checks and fixes are independently testable.
 */

import type { SingleProjectConfig, StatusOptions } from "../config/forge-toml";
import type { ForgeGitHubClient } from "../github/client";
import { resolveGhToken } from "../github/auth";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Severity of a check result. */
export type CheckSeverity = "ok" | "warning" | "error";

/** Category of check — determines what subsystem it validates. */
export type CheckCategory = "local" | "github" | "config";

/** Result of a single doctor check. */
export interface DoctorCheck {
	/** Machine-readable check id. */
	id: string;
	/** Human-readable description of what was checked. */
	description: string;
	/** Result severity. */
	severity: CheckSeverity;
	/** Category: local environment, GitHub state, or config schema. */
	category: CheckCategory;
	/** Detail message (what's wrong, or confirmation). */
	detail: string;
	/** Whether this check can be auto-fixed. */
	fixable: boolean;
}

/** Full doctor report. */
export interface DoctorReport {
	checks: DoctorCheck[];
	/** Count by severity. */
	errors: number;
	warnings: number;
	/** All checks that passed. */
	passed: number;
}

/** Board field data from GitHub (for option comparison). */
export interface BoardFieldInfo {
	fieldId: string;
	options: Array<{ id: string; name: string }>;
}

// --- Local environment checks ---

/** Check 1: .forge.toml exists in the project root. */
export function checkConfigExists(cwd: string): DoctorCheck {
	const exists = existsSync(join(cwd, ".forge.toml"));
	return {
		id: "config-exists",
		description: ".forge.toml exists",
		category: "local",
		severity: exists ? "ok" : "error",
		detail: exists ? "Found .forge.toml in project root." : "No .forge.toml found. Run `/forge setup`.",
		fixable: false,
	};
}

/** Check 2: GitHub auth token is resolvable. */
export function checkGhAuth(): DoctorCheck {
	const auth = resolveGhToken();
	const ok = auth !== null;
	return {
		id: "gh-auth",
		description: "GitHub authentication token available",
		category: "local",
		severity: ok ? "ok" : "error",
		detail: ok
			? `Token resolved from ${auth?.source}.`
			: "No token found. Run `gh auth login` or set GH_TOKEN/GITHUB_TOKEN.",
		fixable: false,
	};
}

/** Check 3: A binary is on PATH (gate tools, gh CLI). */
export function checkBinary(
	name: string,
	available: boolean,
): DoctorCheck {
	return {
		id: `binary-${name}`,
		description: `Tool '${name}' is installed`,
		category: "local",
		severity: available ? "ok" : "error",
		detail: available
			? `'${name}' found on PATH.`
			: `'${name}' not found. Install it or remove from gate.`,
		fixable: false,
	};
}

/** Extract binary names from gate commands (first word of each command). */
export function extractGateBinaries(gate: string[]): string[] {
	const binaries = new Set<string>();
	for (const cmd of gate) {
		const parts = cmd.trim().split(/\s+/);
		const bin = parts[0];
		if (bin !== undefined && bin.length > 0) {
			if (bin === "bunx" && parts[1] !== undefined) {
				binaries.add(parts[1]);
			} else {
				binaries.add(bin);
			}
		}
	}
	return [...binaries];
}

// --- GitHub board checks ---

/** Fetch board field info from GitHub to compare with config. */
export async function fetchBoardFieldInfo(
	client: ForgeGitHubClient,
	projectId: string,
): Promise<BoardFieldInfo | null> {
	const query = `
		query($id: ID!) {
			node(id: $id) {
				... on ProjectV2 {
					fields(first: 50) {
						nodes {
							... on ProjectV2SingleSelectField { id name options { id name } }
						}
					}
				}
			}
		}`;
	const result = await client.graphql<{
		node: {
			fields: {
				nodes: Array<{
					id: string;
					name: string;
					options?: Array<{ id: string; name: string }>;
				}>;
			};
		} | null;
	}>(query, { id: projectId });

	if (result.node === null) return null;

	const statusField = result.node.fields.nodes.find(
		(f) => f.name.toLowerCase() === "status" && f.options !== undefined,
	);
	if (statusField === undefined || statusField.options === undefined) return null;

	return { fieldId: statusField.id, options: statusField.options };
}

/** Check 4: Board project exists and is accessible. */
export function checkBoardExists(
	fieldInfo: BoardFieldInfo | null,
	config: SingleProjectConfig,
): DoctorCheck {
	const exists = fieldInfo !== null;
	return {
		id: "board-exists",
		description: `Board project ${config.projectId} accessible`,
		category: "github",
		severity: exists ? "ok" : "error",
		detail: exists
			? "Board found and accessible."
			: `Cannot read board ${config.projectId}. Check project_id or token scopes.`,
		fixable: false,
	};
}

/** Check 5: Configured status_field_id matches the board's current field. */
export function checkBoardFieldId(
	fieldInfo: BoardFieldInfo | null,
	config: SingleProjectConfig,
): DoctorCheck {
	if (fieldInfo === null) {
		return {
			id: "board-field-id",
			description: "Status field ID matches board",
			category: "github",
			severity: "error",
			detail: "Cannot verify — board not accessible.",
			fixable: false,
		};
	}
	const matches = fieldInfo.fieldId === config.statusFieldId;
	return {
		id: "board-field-id",
		description: "Status field ID matches board",
		category: "github",
		severity: matches ? "ok" : "warning",
		detail: matches
			? "Status field ID is current."
			: `Config has '${config.statusFieldId}' but board has '${fieldInfo.fieldId}'. Board may have been reconstruišened.`,
		fixable: matches ? false : true,
	};
}

/** Normalize option name for comparison. */
function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[\s_-]/g, "");
}

/** Map forge status keys to expected board option name patterns. */
const STATUS_NAME_PATTERNS: Record<keyof StatusOptions, string[]> = {
	backlog: ["backlog"],
	ready: ["ready"],
	inProgress: ["inprogress", "inprogress"],
	inReview: ["inreview", "inreview"],
	done: ["done"],
};

/** Check 6: Configured status_options match the board's current options. */
export function checkBoardOptions(
	fieldInfo: BoardFieldInfo | null,
	config: SingleProjectConfig,
): DoctorCheck {
	if (fieldInfo === null) {
		return {
			id: "board-options",
			description: "Status option IDs match board",
			category: "github",
			severity: "error",
			detail: "Cannot verify — board not accessible.",
			fixable: false,
		};
	}

	const mismatches = findOptionMismatches(config.statusOptions, fieldInfo);
	const allMatch = mismatches.length === 0;

	return {
		id: "board-options",
		description: "Status option IDs match board",
		category: "github",
		severity: allMatch ? "ok" : "warning",
		detail: allMatch
			? "All status option IDs are current."
			: `${mismatches.length} option(s) mismatched: ${mismatches.join(", ")}. Board options may have been recreated.`,
		fixable: !allMatch,
	};
}

/** Find which status options in config don't match the board. */
export function findOptionMismatches(
	configOptions: StatusOptions,
	fieldInfo: BoardFieldInfo,
): string[] {
	const mismatches: string[] = [];
	const boardByName = new Map<string, string>();
	for (const opt of fieldInfo.options) {
		boardByName.set(normalizeName(opt.name), opt.id);
	}

	const checks: Array<[keyof StatusOptions, string]> = [
		["backlog", configOptions.backlog],
		["ready", configOptions.ready],
		["inProgress", configOptions.inProgress],
		["inReview", configOptions.inReview],
		["done", configOptions.done],
	];

	for (const [key, configId] of checks) {
		const patterns = STATUS_NAME_PATTERNS[key];
		const boardId = patterns
			.map((p) => boardByName.get(p))
			.find((id) => id !== undefined);
		if (boardId !== undefined && boardId !== configId) {
			mismatches.push(`${key}: '${configId}' → '${boardId}'`);
		}
	}
	return mismatches;
}

// --- Report assembly ---

/** Assemble a doctor report from individual check results. */
export function assembleReport(checks: DoctorCheck[]): DoctorReport {
	let errors = 0;
	let warnings = 0;
	let passed = 0;
	for (const check of checks) {
		if (check.severity === "error") errors++;
		else if (check.severity === "warning") warnings++;
		else passed++;
	}
	return { checks, errors, warnings, passed };
}

/** Format a doctor report for display. */
export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = ["=== Forge Doctor ===", ""];

	for (const check of report.checks) {
		const icon = check.severity === "error" ? "✗"
			: check.severity === "warning" ? "!"
			: "✓";
		lines.push(`  [${icon}] ${check.description}`);
		if (check.severity !== "ok") {
			lines.push(`      → ${check.detail}`);
			if (check.fixable) {
				lines.push("      → Auto-fixable.");
			}
		}
	}

	lines.push("");
	lines.push(
		`${report.passed} passed, ${report.warnings} warnings, ${report.errors} errors`,
	);
	return lines.join("\n");
}
