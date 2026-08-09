/**
 * `/forge` slash command — routes subcommands.
 *
 *   setup     — interactive config discovery + .forge.toml generation
 *   board     — render board table grouped by Status
 *   decompose — LLM: create issues from spec slice
 *   dispatch  — verify blockers + move card + emit worker prompt
 *   review    — LLM: review PR against acceptance criteria
 *   decide    — record decision, close issue, report unblocked
 *   round     — orchestrate: dispatch → review → sync → promote
 *   promote   — find unblocked + acceptance-complete → move to Ready
 *   status    — one-liner per project (multi-repo)
 *   thinking-report — [v2] analyze thinking-level telemetry (requires self_improvement)
 *   retrospect      — [v2] milestone retrospective from GitHub + session history (requires self_improvement)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { renderBoard, type BoardRenderer } from "./board-render";
import { getBoardState, moveCard } from "../github/board";
import { getGitHubClient, type ForgeGitHubClient } from "../github/client";
import { loadConfig } from "../config/forge-config-loader";
import type { SingleProjectConfig, ForgeConfig } from "../config/forge-toml";
import { getBlockers, getAcceptanceStatus, closeIssueWithComment, getIssueBody } from "../github/issue";
import { buildReviewContract, formatReviewContract } from "../github/pr";
import { writeFileSync } from "node:fs";
import {
	extractTelemetryEntries,
	analyzeTelemetry,
	formatTelemetryReport,
} from "../telemetry/telemetry";
import { generateRetrospect } from "../retrospect/retrospect";
import {
	checkConfigExists,
	checkGhAuth,
	checkBinary,
	checkBoardExists,
	checkBoardFieldId,
	checkBoardOptions,
	extractGateBinaries,
	fetchBoardFieldInfo,
	assembleReport,
	formatDoctorReport,
	type DoctorCheck,
} from "../doctor/doctor";
import { serializeForgeToml } from "../config/forge-toml";
import { join } from "node:path";

/** Parse raw args string into [subcommand, ...rest]. */
export function parseArgs(raw: string): { sub: string; args: string[] } {
	const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
	return { sub: parts[0] ?? "", args: parts.slice(1) };
}

export const USAGE = "Usage: /forge <setup|board|decompose|dispatch|review|decide|round|promote|status|thinking-report|retrospect|doctor> [args]";

const KNOWN_SUBCOMMANDS = new Set([
	"setup", "board", "decompose", "dispatch", "review",
	"decide", "round", "promote", "status",
	"thinking-report", "retrospect", "doctor",
]);

/** Register the /forge command. */
export function registerForgeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("forge", {
		description: "Forge: spec-driven SDLC loop (board, dispatch, review, round, ...)",
		async handler(args, ctx) {
			const { sub, args: subArgs } = parseArgs(args);
			if (sub.length === 0 || !KNOWN_SUBCOMMANDS.has(sub)) {
				if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
				return;
			}
			try {
				await routeSubcommand(sub, subArgs, pi, ctx);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (ctx.hasUI) ctx.ui.notify(`/forge ${sub} failed: ${msg}`, "error");
			}
		},
	});
}

async function routeSubcommand(
	sub: string, args: string[], pi: ExtensionAPI, ctx: ExtensionCommandContext,
): Promise<void> {
	switch (sub) {
		case "board":     return cmdBoard(args, ctx);
		case "setup":     return cmdSetup(args, ctx);
		case "promote":   return cmdPromote(ctx);
		case "decide":    return cmdDecide(args, ctx);
		case "dispatch":  return cmdDispatch(args, pi, ctx);
		case "round":     return cmdRound(args, ctx);
		case "decompose": return cmdDecompose(args, pi, ctx);
		case "review":    return cmdReview(args, pi, ctx);
		case "status":           return cmdStatus(ctx);
		case "thinking-report":  return cmdThinkingReport(ctx);
		case "retrospect":       return cmdRetrospect(args, pi, ctx);
		case "doctor":           return cmdDoctor(pi, ctx);
		default: return;
	}
}

// --- shared helpers ---

function requireClient(ctx: ExtensionCommandContext) {
	const client = getGitHubClient();
	if (client === null) {
		if (ctx.hasUI) ctx.ui.notify("forge: GitHub auth not found. Run `gh auth login` or set GH_TOKEN.", "error");
	}
	return client;
}

/** Extract --project flag from args, returning [projectName, remainingArgs]. */
function extractProjectFlag(args: string[]): { projectName: string | undefined; rest: string[] } {
	const idx = args.indexOf("--project");
	if (idx !== -1 && idx + 1 < args.length) {
		const projectName = args[idx + 1];
		const rest = args.filter((_, i) => i !== idx && i !== idx + 1);
		return { projectName, rest };
	}
	return { projectName: undefined, rest: args };
}

/** Load config, narrowing to a single project. Handles --project flag for multi-repo. */
function requireConfig(
	ctx: ExtensionCommandContext,
	projectName?: string,
): SingleProjectConfig | null {
	const config = loadConfig(ctx.cwd);
	if (config === null) {
		if (ctx.hasUI) ctx.ui.notify("forge: .forge.toml not found. Run `/forge setup` first.", "error");
		return null;
	}
	if ("projects" in config) {
		if (projectName === undefined) {
			if (ctx.hasUI) ctx.ui.notify("forge: multi-project mode — use `--project <name>`.", "warning");
			return null;
		}
		const project = config.projects.find(
			(p) => p.repo.split("/")[1] === projectName || p.path === projectName,
		);
		if (project === undefined) {
			if (ctx.hasUI) ctx.ui.notify(`forge: project "${projectName}" not found in .forge.toml.`, "error");
			return null;
		}
		const { path: _path, ...single } = project;
		void _path;
		return single;
	}
	return config;
}

// --- /forge board ---

async function cmdBoard(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const { projectName, rest } = extractProjectFlag(args);
	const filter = rest[0];
	const client = requireClient(ctx);
	if (client === null) return;
	const config = requireConfig(ctx, projectName);
	if (config === null) return;

	const state = await getBoardState(client, config);
	const renderer: BoardRenderer = {
		notify: (msg, type) => ctx.ui.notify(msg, type),
		hasUI: ctx.hasUI,
	};
	renderBoard(state, filter, renderer);
}

// --- /forge promote (zero LLM) ---

async function cmdPromote(ctx: ExtensionCommandContext): Promise<void> {
	const client = requireClient(ctx);
	if (client === null) return;
	const config = requireConfig(ctx);
	if (config === null) return;

	const state = await getBoardState(client, config);
	const backlogItems = state.items.filter((i) => i.status === "Backlog" && i.state === "OPEN");
	const promoted: number[] = [];

	// Sequential: GitHub API calls must not parallelize (rate-limit + card-move ordering)
	// eslint-disable-next-line no-await-in-loop
	for (const item of backlogItems) {
		const blockers = await getBlockers(client, config.repo, item.issueNumber);
		if (blockers.openBlockers.length > 0) continue;

		const acceptance = await getAcceptanceStatus(client, config.repo, item.issueNumber);
		if (!acceptance.complete) continue;

		await moveCard(client, config, item.issueNumber, "ready");
		promoted.push(item.issueNumber);
	}

	if (promoted.length === 0) {
		if (ctx.hasUI) ctx.ui.notify("forge promote: no issues eligible (all backlog items are blocked or incomplete).", "info");
	} else {
		if (ctx.hasUI) ctx.ui.notify(`forge promote: promoted ${promoted.map((n) => `#${n}`).join(", ")} to Ready.`, "info");
	}
}

// --- /forge decide <N> <text> (zero LLM) ---

async function cmdDecide(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	if (args.length < 2) {
		if (ctx.hasUI) ctx.ui.notify("Usage: /forge decide <issue-number> <decision text>", "warning");
		return;
	}

	const issueNum = parseInt(args[0] ?? "", 10);
	if (Number.isNaN(issueNum)) {
		if (ctx.hasUI) ctx.ui.notify("forge decide: invalid issue number.", "error");
		return;
	}

	const decisionText = args.slice(1).join(" ");
	const client = requireClient(ctx);
	if (client === null) return;
	const config = requireConfig(ctx);
	if (config === null) return;

	const comment = `## Decision\n\n${decisionText}`;
	await closeIssueWithComment(client, config.repo, issueNum, comment);

	// Find issues that were blocked by this one and are now unblocked
	const state = await getBoardState(client, config);
	const potentiallyUnblocked = state.items.filter(
		(i) => i.status === "Backlog" && i.state === "OPEN",
	);

	const unblocked: number[] = [];
	for (const item of potentiallyUnblocked) {
		const blockers = await getBlockers(client, config.repo, item.issueNumber);
		if (!blockers.allBlockers.includes(issueNum)) continue;
		if (blockers.openBlockers.length === 0) {
			unblocked.push(item.issueNumber);
		}
	}

	const unblockedMsg = unblocked.length > 0
		? ` Newly unblocked: ${unblocked.map((n) => `#${n}`).join(", ")}.`
		: "";
	if (ctx.hasUI) ctx.ui.notify(`forge decide: closed #${issueNum} with decision.${unblockedMsg} Run \`/forge promote\` to move them to Ready.`, "info");
}

// --- /forge dispatch <N> (TS verify + LLM worker prompt) ---

async function cmdDispatch(
	args: string[], pi: ExtensionAPI, ctx: ExtensionCommandContext,
): Promise<void> {
	const { projectName, rest } = extractProjectFlag(args);
	if (rest.length < 1) {
		if (ctx.hasUI) ctx.ui.notify("Usage: /forge dispatch <issue-number> [--project <name>]", "warning");
		return;
	}

	const issueNum = parseInt(rest[0] ?? "", 10);
	if (Number.isNaN(issueNum)) {
		if (ctx.hasUI) ctx.ui.notify("forge dispatch: invalid issue number.", "error");
		return;
	}

	const client = requireClient(ctx);
	if (client === null) return;
	const config = requireConfig(ctx, projectName);
	if (config === null) return;

	// Verify unblocked
	const blockers = await getBlockers(client, config.repo, issueNum);
	if (blockers.openBlockers.length > 0) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`forge dispatch: #${issueNum} blocked by open issues: ${blockers.openBlockers.map((n) => `#${n}`).join(", ")}.`,
				"warning",
			);
		}
		return;
	}

	// Move card to In progress
	await moveCard(client, config, issueNum, "in_progress");

	// Build worker prompt from issue body
	const body = await getIssueBody(client, config.repo, issueNum);
	const gate = config.gate.map((g) => `  ${g}`).join("\n");
	const slug = (config.repo.split("/")[1] ?? "task").toLowerCase();

	const prompt = [
		`Implement issue #${issueNum} in repo ${config.repo}.`,
		"",
		body,
		"",
		"## Rules (non-negotiable)",
		`- Work in branch \`impl/${issueNum}-${slug}\`; never touch main.`,
		"- TDD: write failing tests for each acceptance criterion first.",
		"- Gate before yielding (ALL must pass, zero warnings):",
		gate,
		`- Open a draft PR with "Fixes #${issueNum}". Report PR URL + test names.`,
	].join("\n");

	pi.sendMessage(
		{ content: [{ type: "text", text: prompt }] },
		{ triggerTurn: true, deliverAs: "nextTurn" },
	);
	if (ctx.hasUI) ctx.ui.notify(`forge dispatch: #${issueNum} moved to In progress, worker prompt emitted.`, "info");
}

// --- /forge round (TS orchestrates; LLM for dispatch + review) ---

async function cmdRound(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const { projectName } = extractProjectFlag(args);
	const client = requireClient(ctx);
	if (client === null) return;
	const config = requireConfig(ctx, projectName);
	if (config === null) return;

	const state = await getBoardState(client, config);
	const report: string[] = ["Forge round report:", ""];

	// 1. Dispatch Ready issues (unblocked)
	const readyItems = state.items.filter((i) => i.status === "Ready" && i.state === "OPEN");
	const dispatchable: number[] = [];
	for (const item of readyItems) {
		const blockers = await getBlockers(client, config.repo, item.issueNumber);
		if (blockers.openBlockers.length === 0) {
			dispatchable.push(item.issueNumber);
			await moveCard(client, config, item.issueNumber, "in_progress");
		}
	}
	report.push(`Dispatched: ${dispatchable.length > 0 ? dispatchable.map((n) => `#${n}`).join(", ") : "(none)"}`);

	// 2. Check PRs in In review — are they merged?
	const inReviewItems = state.items.filter((i) => i.status === "In review" && i.state === "CLOSED");
	const doneItems: number[] = [];
	for (const item of inReviewItems) {
		await moveCard(client, config, item.issueNumber, "done");
		doneItems.push(item.issueNumber);
	}
	report.push(`Done (merged): ${doneItems.length > 0 ? doneItems.map((n) => `#${n}`).join(", ") : "(none)"}`);

	// 3. Promote newly unblocked
	const backlogItems = state.items.filter((i) => i.status === "Backlog" && i.state === "OPEN");
	const promotable: number[] = [];
	for (const item of backlogItems) {
		const blockers = await getBlockers(client, config.repo, item.issueNumber);
		if (blockers.openBlockers.length > 0) continue;
		const acceptance = await getAcceptanceStatus(client, config.repo, item.issueNumber);
		if (!acceptance.complete) continue;
		await moveCard(client, config, item.issueNumber, "ready");
		promotable.push(item.issueNumber);
	}
	report.push(`Promoted: ${promotable.length > 0 ? promotable.map((n) => `#${n}`).join(", ") : "(none)"}`);

	// 4. Blocked
	report.push(`Blocked (still in Backlog): ${backlogItems.length - promotable.length}`);

	// 5. Decisions needed
	const decisionsNeeded = state.items.filter((i) => i.title.includes("needs-decision"));
	report.push(`Decisions needed: ${decisionsNeeded.length > 0 ? decisionsNeeded.map((i) => `#${i.issueNumber}`).join(", ") : "0"}`);

	report.push("", "Next: run `/forge dispatch <N>` for dispatched issues when workers report PRs, `/forge review <N>` when ready.");

	if (ctx.hasUI) ctx.ui.notify(report.join("\n"), "info");
}

// --- /forge review <N> (LLM) ---

async function cmdReview(
	args: string[], pi: ExtensionAPI, ctx: ExtensionCommandContext,
): Promise<void> {
	if (args.length < 1) {
		if (ctx.hasUI) ctx.ui.notify("Usage: /forge review <pr-or-issue-number>", "warning");
		return;
	}

	const num = parseInt(args[0] ?? "", 10);
	if (Number.isNaN(num)) {
		if (ctx.hasUI) ctx.ui.notify("forge review: invalid number.", "error");
		return;
	}

	const client = requireClient(ctx);
	if (client === null) return;
	const config = requireConfig(ctx);
	if (config === null) return;

	const body = await getIssueBody(client, config.repo, num);
	const contract = buildReviewContract(num, body);
	const contractStr = formatReviewContract(contract);

	const prompt = [
		`Review the change for issue/pr #${num} against its acceptance criteria.`,
		"",
		contractStr,
		"",
		`Fetch the diff via \`pr://${num}/diff/all\` and check:`,
		"- Does every acceptance criterion have a real test?",
		"- Zero-warnings gate (all gate commands pass)?",
		"- Anti-patterns: no stubs, no placeholders, no bypass of invariants.",
		"Report findings by severity. Clean → recommend merge.",
	].join("\n");

	pi.sendMessage(
		{ content: [{ type: "text", text: prompt }] },
		{ triggerTurn: true, deliverAs: "nextTurn" },
	);
	if (ctx.hasUI) ctx.ui.notify(`forge review: emitted review prompt for #${num}.`, "info");
}

// --- /forge decompose <slice> (LLM) ---

async function cmdDecompose(
	args: string[], pi: ExtensionAPI, ctx: ExtensionCommandContext,
): Promise<void> {
	if (args.length < 1) {
		if (ctx.hasUI) ctx.ui.notify("Usage: /forge decompose <slice-number>", "warning");
		return;
	}

	const slice = args[0] ?? "";
	const client = requireClient(ctx);
	if (client === null) return;
	const config = requireConfig(ctx);
	if (config === null) return;

	const specIndex = config.specIndex ?? "docs/AGENTS.md";
	const specPrefix = config.specIdPrefix ?? "REQ";

	const prompt = [
		`Decompose Slice ${slice} from the spec into GitHub issues on ${config.repo}.`,
		"",
		`Read the slice scope from your implementation guide and the spec reverse-index at \`${specIndex}\`.`,
		"Create issues using the `.github/ISSUE_TEMPLATE/implementation-task.md` format:",
		`- Labels: \`impl\` + \`slice-${slice}\``,
		"- Wire `--blocked-by` for dependencies",
		`- Complete acceptance criteria: one named test per \`${specPrefix}-*\` plus the gate:`,
		`  ${config.gate.join(", ")}`,
		"- Milestone: `Slice N — <title>`",
		"- No workers, no code, nothing promoted to Ready.",
		"Report: issue numbers, dependency graph, root issues.",
	].join("\n");

	pi.sendMessage(
		{ content: [{ type: "text", text: prompt }] },
		{ triggerTurn: true, deliverAs: "nextTurn" },
	);
	if (ctx.hasUI) ctx.ui.notify(`forge decompose: emitted decompose prompt for Slice ${slice}.`, "info");
}

// --- /forge setup (interactive) ---

async function cmdSetup(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const client = requireClient(ctx);
	if (client === null) return;

	// Discover repos from git remote
	let repo = "";
	try {
		const result = await ctx.waitForIdle().then(() => null).catch(() => null);
		void result;
	} catch { void 0; }

	// Use exec to get git remote
	// For now, ask the user
	if (ctx.hasUI) {
		repo = await ctx.ui.input("GitHub repo (owner/name):", "owner/name") ?? "";
	}
	if (repo.length === 0) {
		if (ctx.hasUI) ctx.ui.notify("forge setup: cancelled.", "warning");
		return;
	}

	// Query user's projects
	const query = `
		query {
			viewer {
				projectsV2(first: 20) {
					nodes { id title }
				}
			}
		}`;
	const projectsResult = await client.graphql<{
		viewer: { projectsV2: { nodes: Array<{ id: string; title: string }> } };
	}>(query);

	const projects = projectsResult.viewer.projectsV2.nodes;
	if (projects.length === 0) {
		if (ctx.hasUI) ctx.ui.notify("forge setup: no Projects v2 boards found. Create one first.", "error");
		return;
	}

	let selectedProject: { id: string; title: string } | undefined;
	if (ctx.hasUI && ctx.ui.askDialog !== undefined) {
		const result = await ctx.ui.askDialog([{
			id: "project",
			question: "Which board tracks this project?",
			options: projects.map((p) => ({ label: p.title, description: p.id })),
		}]);
		if (result !== undefined && result.kind === "submit") {
			const firstResult = result.results[0];
			const selectedTitle = firstResult?.selectedOptions[0];
			if (selectedTitle !== undefined) {
				selectedProject = projects.find((p) => p.title === selectedTitle);
			}
		}
	} else {
		selectedProject = projects[0];
	}

	if (selectedProject === undefined) {
		if (ctx.hasUI) ctx.ui.notify("forge setup: no project selected.", "warning");
		return;
	}

	// Query project fields to find Status single-select
	const fieldsQuery = `
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
	const fieldsResult = await client.graphql<{
		node: {
			fields: {
				nodes: Array<{
					id: string;
					name: string;
					options?: Array<{ id: string; name: string }>;
				}>;
			};
		};
	}>(fieldsQuery, { id: selectedProject.id });

	const statusField = fieldsResult.node.fields.nodes.find(
		(f) => f.name.toLowerCase() === "status" && f.options !== undefined,
	);

	if (statusField === undefined || statusField.options === undefined) {
		if (ctx.hasUI) ctx.ui.notify("forge setup: no Status single-select field found on project.", "error");
		return;
	}

	// Map option names to forge's expected names
	const findOpt = (names: string[]): string => {
		for (const name of names) {
			const opt = statusField.options?.find(
				(o) => o.name.toLowerCase() === name.toLowerCase(),
			);
			if (opt !== undefined) return opt.id;
		}
		return statusField.options?.[0]?.id ?? "";
	};

	// Detect stack for gate defaults
	const cwd = ctx.cwd;
	let gate = ["cargo test", "cargo clippy --all-targets -- -D warnings"];
	try {
		writeFileSync(join(cwd, ".stackcheck"), ""); // trigger fs check
	} catch { void 0; }
	// Simplified: assume Rust for now — full stack detection is a future enhancement

	const toml = [
		`repo = "${repo}"`,
		`project_id = "${selectedProject.id}"`,
		`status_field_id = "${statusField.id}"`,
		`status_options = { backlog = "${findOpt(["Backlog"])}", ready = "${findOpt(["Ready"])}", in_progress = "${findOpt(["In progress", "In Progress"])}", in_review = "${findOpt(["In review", "In Review"])}", done = "${findOpt(["Done"])}" }`,
		`gate = [${gate.map((g) => `"${g}"`).join(", ")}]`,
		`spec_id_prefix = "REQ"`,
	].join("\n");

	const configPath = join(cwd, ".forge.toml");
	writeFileSync(configPath, `# .forge.toml — generated by forge setup\n\n${toml}\n`);

	if (ctx.hasUI) {
		ctx.ui.notify(`forge setup: wrote .forge.toml (project: ${selectedProject.title}).`, "info");
	}
}

// --- /forge status ---

async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig(ctx.cwd);
	if (config === null) {
		if (ctx.hasUI) ctx.ui.notify("forge: not configured. Run `/forge setup`.", "warning");
		return;
	}

	const client = requireClient(ctx);
	if (client === null) return;

	if ("projects" in config) {
		// Multi-project
		const lines: string[] = [];
		for (const project of config.projects) {
			const state = await getBoardState(client, project);
			const counts = countByStatus(state);
			lines.push(`${project.repo}: ${counts["ready"]} ready, ${counts["in_progress"]} in progress, ${counts["in_review"]} in review, ${counts["backlog"]} backlog`);
		}
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	const state = await getBoardState(client, config);
	const counts = countByStatus(state);
	const total = state.items.length;
	if (ctx.hasUI) {
		ctx.ui.notify(
			`${config.repo}: ${total} total — ${counts["backlog"]} backlog, ${counts["ready"]} ready, ${counts["in_progress"]} in progress, ${counts["in_review"]} in review, ${counts["done"]} done`,
			"info",
		);
	}
}

function countByStatus(state: { items: Array<{ status: string }> }): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of state.items) {
		counts[item.status] = (counts[item.status] ?? 0) + 1;
	}
	return counts;
}


// --- v2: self-improvement gate helper ---

/** Check if self_improvement is enabled. Returns config if yes, null if not. */
function requireSelfImprovement(ctx: ExtensionCommandContext): SingleProjectConfig | null {
	const config = loadConfig(ctx.cwd);
	if (config === null) {
		if (ctx.hasUI) ctx.ui.notify("forge: .forge.toml not found. Run `/forge setup` first.", "error");
		return null;
	}
	if ("projects" in config) {
		const enabled = config.projects.find((p) => p.selfImprovement === true);
		if (enabled === undefined) {
			if (ctx.hasUI) ctx.ui.notify("forge: this command requires `self_improvement = true` in .forge.toml.", "error");
			return null;
		}
		const { path: _path, ...single } = enabled;
		void _path;
		return single;
	}
	if (config.selfImprovement !== true) {
		if (ctx.hasUI) ctx.ui.notify("forge: this command requires `self_improvement = true` in .forge.toml.", "error");
		return null;
	}
	return config;
}

// --- /forge thinking-report (v2, requires self_improvement) ---

async function cmdThinkingReport(ctx: ExtensionCommandContext): Promise<void> {
	if (requireSelfImprovement(ctx) === null) return;

	const branch = ctx.sessionManager.getBranch();
	const entries = extractTelemetryEntries(branch as never);
	const report = analyzeTelemetry(entries);
	const text = formatTelemetryReport(report);

	if (ctx.hasUI) {
		ctx.ui.notify(text, "info");
	}
}

// --- /forge retrospect [--milestone N] (v2, requires self_improvement) ---

async function cmdRetrospect(
	args: string[], pi: ExtensionAPI, ctx: ExtensionCommandContext,
): Promise<void> {
	const config = requireSelfImprovement(ctx);
	if (config === null) return;

	const client = requireClient(ctx);
	if (client === null) return;

	const milestoneNum = extractMilestoneFlag(args);
	const branch = ctx.sessionManager.getBranch();
	const telemetryEntries = extractTelemetryEntries(branch as never);

	const input: Parameters<typeof generateRetrospect>[2] = {
		sessionBranch: branch as never,
		telemetryEntries,
	};
	if (milestoneNum !== undefined) {
		input.milestoneNumber = milestoneNum;
	}
	const report = await generateRetrospect(client, config, input);

	const reportText = formatRetrospectReport(report);

	if (ctx.hasUI) {
		ctx.ui.notify(reportText, "info");
	}

	pi.sendMessage(
		{ content: [{ type: "text", text: reportText }] },
		{ triggerTurn: false, deliverAs: "nextTurn" },
	);
}

/** Extract --milestone N from args. */
function extractMilestoneFlag(args: string[]): number | undefined {
	const idx = args.indexOf("--milestone");
	if (idx !== -1 && idx + 1 < args.length) {
		const num = Number(args[idx + 1]);
		if (!Number.isNaN(num)) return num;
	}
	return undefined;
}

/** Format a retrospect report for display. */
function formatRetrospectReport(report: { summary: string; findings: string[]; recommendations: string[] }): string {
	const lines: string[] = ["=== Forge Retrospective ===", ""];
	lines.push(report.summary);
	lines.push("");
	if (report.findings.length > 0) {
		lines.push("Findings:");
		for (const f of report.findings) {
			lines.push(`  • ${f}`);
		}
		lines.push("");
	}
	if (report.recommendations.length > 0) {
		lines.push("Recommendations:");
		for (const r of report.recommendations) {
			lines.push(`  → ${r}`);
		}
	}
	return lines.join("\n");
}

// --- /forge doctor (v2: environment + board sync diagnostics) ---

async function cmdDoctor(
	pi: ExtensionAPI, ctx: ExtensionCommandContext,
): Promise<void> {
	const checks: DoctorCheck[] = [];

	// --- Local checks ---
	checks.push(checkConfigExists(ctx.cwd));
	checks.push(checkGhAuth());

	const config = loadConfig(ctx.cwd);
	if (config !== null) {
		const singleConfig = "projects" in config ? null : config;
		if (singleConfig !== null) {
			const gateBins = extractGateBinaries(singleConfig.gate);
			for (const bin of gateBins) {
				const available = await checkToolAvailable(pi, bin);
				checks.push(checkBinary(bin, available));
			}
		}
	}

	// --- GitHub checks ---
	const client = getGitHubClient();
	if (client !== null && config !== null && "projects" in config === false) {
		const singleConfig = config as SingleProjectConfig;
		const fieldInfo = await fetchBoardFieldInfo(client, singleConfig.projectId);
		checks.push(checkBoardExists(fieldInfo, singleConfig));
		checks.push(checkBoardFieldId(fieldInfo, singleConfig));
		checks.push(checkBoardOptions(fieldInfo, singleConfig));
	}

	const report = assembleReport(checks);
	const text = formatDoctorReport(report);

	if (ctx.hasUI) {
		ctx.ui.notify(text, report.errors > 0 ? "error" : "warning");
	}

	// Offer fixes for fixable checks
	const fixableChecks = checks.filter((c) => c.fixable && c.severity !== "ok");
	if (fixableChecks.length > 0 && ctx.hasUI) {
		await offerFixes(fixableChecks, client, config, ctx);
	}
}

/** Check if a binary is available on PATH. */
async function checkToolAvailable(
	pi: ExtensionAPI,
	binary: string,
): Promise<boolean> {
	try {
		const result = await pi.exec("which", [binary]);
		return result.code === 0;
	} catch {
		return false;
	}
}

/** Offer to fix fixable checks one by one, with confirmation. */
async function offerFixes(
	fixableChecks: DoctorCheck[],
	client: ForgeGitHubClient | null,
	config: ForgeConfig | null,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (client === null || config === null || "projects" in config) return;

	for (const check of fixableChecks) {
		if (check.id === "board-field-id" || check.id === "board-options") {
			const confirmed = await ctx.ui.confirm(
				"forge doctor",
				`${check.description}:\n${check.detail}\n\nFix .forge.toml with current board values?`,
			);
			if (!confirmed) continue;

			const fieldInfo = await fetchBoardFieldInfo(client, config.projectId);
			if (fieldInfo === null) {
				ctx.ui.notify("forge doctor: cannot read board — fix skipped.", "error");
				continue;
			}

			const fixed = updateConfigFromBoard(config, fieldInfo);
			writeFileSync(
				join(ctx.cwd, ".forge.toml"),
				serializeForgeToml(fixed),
			);
			ctx.ui.notify(`forge doctor: fixed '${check.description}'.`, "info");
		}
	}
}

/** Update config field_id and status_options from current board state. */
function updateConfigFromBoard(
	config: SingleProjectConfig,
	fieldInfo: { fieldId: string; options: Array<{ id: string; name: string }> },
): SingleProjectConfig {
	const updated: SingleProjectConfig = {
		...config,
		statusFieldId: fieldInfo.fieldId,
		statusOptions: resolveStatusOptions(config.statusOptions, fieldInfo.options),
	};
	return updated;
}

/** Resolve status options from board, keeping config as fallback. */
function resolveStatusOptions(
	current: SingleProjectConfig["statusOptions"],
	boardOptions: Array<{ id: string; name: string }>,
): SingleProjectConfig["statusOptions"] {
	const byName = new Map(boardOptions.map((o) => [o.name.toLowerCase().replace(/[\s_-]/g, ""), o.id]));
	const find = (patterns: string[]): string => {
		for (const p of patterns) {
			const id = byName.get(p);
			if (id !== undefined) return id;
		}
		return "";
	};
	return {
		backlog: find(["backlog"]),
		ready: find(["ready"]),
		inProgress: find(["inprogress"]),
		inReview: find(["inreview"]),
		done: find(["done"]),
	};
}