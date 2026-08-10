import { describe, expect, it } from "bun:test";
import { buildWorkerPrompt, dispatchIssue } from "./dispatch";
import type { SingleProjectConfig } from "../config/forge-toml";
import type { ForgeGitHubClient } from "../github/client";

const baseConfig: SingleProjectConfig = {
	repo: "mjaric/smith",
	projectId: "PVT_test123",
	statusFieldId: "PVTSSF_test",
	statusOptions: {
		backlog: "opt_backlog",
		ready: "opt_ready",
		inProgress: "opt_progress",
		inReview: "opt_review",
		done: "opt_done",
	},
	gate: ["cargo test", "cargo clippy --all-targets -- -D warnings"],
};

/** Narrow the mutation variables we build in moveCard (test-owned shape). */
function readMoveVariables(variables?: Record<string, unknown>): { optionId: string; itemId: string } {
	const value = variables?.["value"];
	const optionId =
		typeof value === "object" && value !== null && "singleSelectOptionId" in value
			? String(value.singleSelectOptionId)
			: "";
	const itemId = typeof variables?.["itemId"] === "string" ? variables["itemId"] : "";
	return { optionId, itemId };
}

/** Mock client: issue bodies/states via rest, board item lookup + move via graphql. */
function mockClient(opts: {
	issues: Record<number, { state: string; body: string }>;
	boardNumbers?: number[];
}): ForgeGitHubClient & { movedCards: Array<{ issue: number; status: string }> } {
	const movedCards: Array<{ issue: number; status: string }> = [];
	const client = {
		rest: {
			issues: {
				get: async (params: { issue_number: number }) => ({
					data: opts.issues[params.issue_number] ?? { state: "closed", body: "" },
				}),
			},
		} as unknown as ForgeGitHubClient["rest"],
		graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
			if (query.includes("content { ... on Issue { number } }")) {
				const numbers = opts.boardNumbers ?? Object.keys(opts.issues).map(Number);
				return {
					node: {
						items: {
							nodes: numbers.map((n) => ({
								id: `item_${n}`,
								content: { number: n },
							})),
						},
					},
				} as T;
			}
			if (query.includes("updateProjectV2ItemFieldValue")) {
				const { optionId, itemId } = readMoveVariables(variables);
				const statusByOption: Record<string, string> = {
					opt_backlog: "backlog",
					opt_ready: "ready",
					opt_progress: "in_progress",
					opt_review: "in_review",
					opt_done: "done",
				};
				movedCards.push({
					issue: parseInt(itemId.replace("item_", ""), 10),
					status: statusByOption[optionId] ?? optionId,
				});
				return { projectV2Item: { id: itemId } } as T;
			}
			throw new Error("unexpected graphql");
		},
		movedCards,
	};
	return client;
}

describe("buildWorkerPrompt", () => {
	it("includes issue body, branch rule, TDD rule, and gate", () => {
		const prompt = buildWorkerPrompt(baseConfig, 42, "## Scope\nDo it.");
		expect(prompt).toContain("Implement issue #42 in repo mjaric/smith.");
		expect(prompt).toContain("## Scope\nDo it.");
		expect(prompt).toContain("impl/42-smith");
		expect(prompt).toContain("cargo test");
		expect(prompt).toContain(`"Fixes #42"`);
	});
});

describe("dispatchIssue", () => {
	it("moves the card and returns the worker prompt when unblocked", async () => {
		const client = mockClient({
			issues: { 42: { state: "open", body: "## Acceptance\n- [x] REQ-1" } },
		});
		const result = await dispatchIssue(client, baseConfig, 42);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.prompt).toContain("Implement issue #42");
		}
		expect(client.movedCards).toEqual([{ issue: 42, status: "in_progress" }]);
	});

	it("refuses and does not touch the board when blockers are open", async () => {
		const client = mockClient({
			issues: {
				42: { state: "open", body: "Blocked by #7" },
				7: { state: "open", body: "" },
			},
		});
		const result = await dispatchIssue(client, baseConfig, 42);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("#7");
		}
		expect(client.movedCards).toEqual([]);
	});
});
