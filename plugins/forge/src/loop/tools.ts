/**
 * Agent-callable forge tools — the seam the `sdlc` skill drives mid-turn.
 *
 * Slash commands are user-invoked; the loop skill needs the same
 * operations reachable from inside a turn, so each is registered as a
 * tool over the shared loop modules:
 *
 *   forge_plan     — query-only round plan (read)
 *   forge_sync     — promote unblocked backlog + mark merged done (write)
 *   forge_dispatch — verify + move card, return the worker prompt (write)
 *   forge_review   — return the review contract for a PR/issue (read)
 *
 * All GitHub access stays in `src/github` + `src/loop`; tools never
 * fetch directly. Errors return `isError: true` with an actionable
 * message instead of throwing.
 *
 * Note: `registerTool` is called with an explicit schema generic —
 * inference through the `TSchema` union widens params to `unknown`.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildForgePlan, capDispatchable, formatForgePlan } from "./plan";
import { dispatchIssue } from "./dispatch";
import { syncBoard, formatSyncReport } from "./round";
import { resolveForge } from "./resolve";
import { getIssueBody } from "../github/issue";
import { buildReviewContract, formatReviewContract } from "../github/pr";

/** Max concurrent workers the loop may dispatch (see AGENTS.md / skill). */
const MAX_WORKERS = 4;

/** Tool error result shaped for the model. */
function errorResult(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Register the forge_* tools used by the sdlc skill. */
export function registerForgeTools(pi: ExtensionAPI): void {
	const { z } = pi.zod;

	const emptyParams = z.object({});
	pi.registerTool<typeof emptyParams>({
		name: "forge_plan",
		label: "Forge Plan",
		description:
			"Query-only SDLC round plan: which issues are dispatchable (Ready, unblocked), " +
			"reviewable (In review with a linked PR), promotable (Backlog, ready for Ready), " +
			"blocked, and milestone completion. Mutates nothing. Call this to decide what to " +
			"dispatch in a loop round.",
		approval: "read",
		parameters: emptyParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const resolved = resolveForge(ctx.cwd);
			if (resolved.ok === false) {
				return errorResult(`forge plan: ${resolved.error}`);
			}
			const plan = await buildForgePlan(resolved.client, resolved.config);
			const capped = capDispatchable(plan.dispatchable, MAX_WORKERS);
			return {
				content: [{ type: "text", text: formatForgePlan(plan) }],
				details: { plan, maxWorkers: MAX_WORKERS, dispatchNow: capped.map((d) => d.issue) },
			};
		},
	});

	pi.registerTool<typeof emptyParams>({
		name: "forge_sync",
		label: "Forge Sync",
		description:
			"Sync the board: promote unblocked + acceptance-complete Backlog issues to Ready and " +
			"move merged In review issues to Done. This is the board-sync half of a round; it does " +
			"not dispatch workers. Run after dispatch/review work settles.",
		approval: "write",
		parameters: emptyParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const resolved = resolveForge(ctx.cwd);
			if (resolved.ok === false) {
				return errorResult(`forge sync: ${resolved.error}`);
			}
			const report = await syncBoard(resolved.client, resolved.config);
			return {
				content: [{ type: "text", text: formatSyncReport(report) }],
				details: report,
			};
		},
	});

	const dispatchParams = z.object({
		issue: z.number().describe("Issue number to dispatch"),
	});
	pi.registerTool<typeof dispatchParams>({
		name: "forge_dispatch",
		label: "Forge Dispatch",
		description:
			"Dispatch one issue for implementation: verify it is unblocked, move its card to " +
			"In progress, and return the worker prompt. Pass the returned prompt to the `task` " +
			"tool (isolated worktree) to spawn the worker. Refuses if blockers are open.",
		approval: "write",
		parameters: dispatchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveForge(ctx.cwd);
			if (resolved.ok === false) {
				return errorResult(`forge dispatch: ${resolved.error}`);
			}
			const result = await dispatchIssue(resolved.client, resolved.config, params.issue);
			if (result.ok === false) {
				return errorResult(`forge dispatch: ${result.error}`);
			}
			return {
				content: [{ type: "text", text: result.prompt }],
				details: { issue: params.issue, workerPrompt: result.prompt },
			};
		},
	});

	const reviewParams = z.object({
		number: z.number().describe("Issue or PR number"),
	});
	pi.registerTool<typeof reviewParams>({
		name: "forge_review",
		label: "Forge Review",
		description:
			"Assemble the review contract for an issue/PR from its acceptance criteria. Pass the " +
			"returned contract to the `reviewer` agent (via `task`) along with the diff " +
			"(pr://<N>/diff/all) to review the change.",
		approval: "read",
		parameters: reviewParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveForge(ctx.cwd);
			if (resolved.ok === false) {
				return errorResult(`forge review: ${resolved.error}`);
			}
			const body = await getIssueBody(resolved.client, resolved.config.repo, params.number);
			const contract = buildReviewContract(params.number, body);
			const contractStr = formatReviewContract(contract);
			return {
				content: [{ type: "text", text: contractStr }],
				details: { number: params.number, contract: contractStr },
			};
		},
	});
}
