import { describe, expect, it } from "bun:test";
import { syncBoard, formatSyncReport } from "./round";
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
	gate: [],
};

interface BoardItemSpec {
	number: number;
	title: string;
	state: string;
	status: string;
}

interface IssueSpec {
	state: string;
	body: string;
}

/** Mock client: board via graphql, issues via rest, moves recorded. */
function mockClient(opts: {
	board: BoardItemSpec[];
	issues?: Record<number, IssueSpec>;
	native?: Record<number, Array<{ number: number; state: string }>>;
}): ForgeGitHubClient & { movedCards: Array<{ issue: number; status: string }> } {
	const issues = opts.issues ?? {};
	const movedCards: Array<{ issue: number; status: string }> = [];
	const statusByOption: Record<string, string> = {
		opt_backlog: "backlog",
		opt_ready: "ready",
		opt_progress: "in_progress",
		opt_review: "in_review",
		opt_done: "done",
	};
	return {
		rest: {
			issues: {
				get: async (params: { issue_number: number }) => ({
					data: issues[params.issue_number] ?? { state: "closed", body: "" },
				}),
			},
		} as unknown as ForgeGitHubClient["rest"],
		graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
			if (query.includes("blockedBy")) {
				const num = Number(variables?.["number"]);
				return { repository: { issue: { blockedBy: { nodes: opts.native?.[num] ?? [] } } } } as T;
			}
			if (query.includes("fieldValues(first: 30)")) {
				return {
					node: {
						id: "PVT_test123",
						items: {
							nodes: opts.board.map((item) => ({
								id: `item_${item.number}`,
								content: { number: item.number, title: item.title, state: item.state, milestone: null },
								fieldValues: { nodes: [{ name: item.status, field: { name: "Status" } }] },
							})),
						},
					},
				} as T;
			}
			if (query.includes("content { ... on Issue { number } }")) {
				return {
					node: {
						items: {
							nodes: opts.board.map((item) => ({
								id: `item_${item.number}`,
								content: { number: item.number },
							})),
						},
					},
				} as T;
			}
			if (query.includes("updateProjectV2ItemFieldValue")) {
				const value = variables?.["value"];
				const optionId =
					typeof value === "object" && value !== null && "singleSelectOptionId" in value
						? String(value.singleSelectOptionId)
						: "";
				const itemId = typeof variables?.["itemId"] === "string" ? variables["itemId"] : "";
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
}

const completeBody = "## Acceptance\n- [x] REQ-1\n";
const writtenBody = "## Acceptance\n- [ ] REQ-1\n";
const noAcceptanceBody = "## Scope\nDo the thing.\n";

describe("syncBoard", () => {
	it("promotes unblocked backlog with written acceptance and counts blocked", async () => {
		const client = mockClient({
			board: [
				{ number: 1, title: "eligible", state: "OPEN", status: "Backlog" },
				{ number: 2, title: "blocked", state: "OPEN", status: "Backlog" },
				{ number: 3, title: "no acceptance", state: "OPEN", status: "Backlog" },
			],
			issues: {
				1: { state: "open", body: completeBody },
				2: { state: "open", body: `Blocked by #7\n\n${completeBody}` },
				3: { state: "open", body: noAcceptanceBody },
				7: { state: "open", body: "" },
			},
		});
		const report = await syncBoard(client, baseConfig);
		expect(report.promoted).toEqual([1]);
		expect(report.blockedCount).toBe(1);
		expect(client.movedCards).toEqual([{ issue: 1, status: "ready" }]);
	});

	it("reads native blocked-by relationships when promoting", async () => {
		const client = mockClient({
			board: [{ number: 1, title: "eligible", state: "OPEN", status: "Backlog" }],
			issues: {
				1: { state: "open", body: writtenBody },
				8: { state: "closed", body: "" },
			},
			native: { 1: [{ number: 8, state: "CLOSED" }] },
		});
		const report = await syncBoard(client, baseConfig);
		expect(report.promoted).toEqual([1]);
		expect(client.movedCards).toEqual([{ issue: 1, status: "ready" }]);
	});

	it("moves merged In review items to Done", async () => {
		const client = mockClient({
			board: [
				{ number: 5, title: "merged", state: "CLOSED", status: "In review" },
				{ number: 6, title: "open review", state: "OPEN", status: "In review" },
			],
		});
		const report = await syncBoard(client, baseConfig);
		expect(report.done).toEqual([5]);
		expect(client.movedCards).toEqual([{ issue: 5, status: "done" }]);
	});

	it("does not dispatch or move In progress / Ready items", async () => {
		const client = mockClient({
			board: [
				{ number: 4, title: "working", state: "OPEN", status: "In progress" },
				{ number: 8, title: "ready", state: "OPEN", status: "Ready" },
			],
		});
		const report = await syncBoard(client, baseConfig);
		expect(report).toEqual({ promoted: [], done: [], blockedCount: 0 });
		expect(client.movedCards).toEqual([]);
	});
});

describe("formatSyncReport", () => {
	it("lists promoted and done issues", () => {
		const out = formatSyncReport({ promoted: [1, 2], done: [5], blockedCount: 3 });
		expect(out).toContain("#1, #2");
		expect(out).toContain("#5");
		expect(out).toContain("3");
	});
});
