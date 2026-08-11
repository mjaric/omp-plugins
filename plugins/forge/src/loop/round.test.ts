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
	linkedPr?: Record<number, number>;
	ci?: Record<string, Array<{ status: string; conclusion: string | null }>>;
	drafts?: Record<number, boolean>;
	reviews?: Record<number, Array<{ state: string; user: string; body?: string }>>;
	headRefs?: Record<number, string>;
}): ForgeGitHubClient & { movedCards: Array<{ issue: number; status: string }>; undrafted: number[] } {
	const issues = opts.issues ?? {};
	const movedCards: Array<{ issue: number; status: string }> = [];
	const undrafted: number[] = [];
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
				listComments: async () => ({ data: [] }),
				listEventsForTimeline: async (params: { issue_number: number }) => ({
					data: opts.linkedPr?.[params.issue_number] !== undefined
						? [{
							event: "cross-referenced",
							source: { issue: { number: opts.linkedPr[params.issue_number], pull_request: {} } },
						}]
						: [],
				}),
			},
			pulls: {
				get: async (params: { pull_number: number }) => ({
					data: {
						head: { sha: "abc123", ref: opts.headRefs?.[params.pull_number] ?? "impl/x" },
						draft: opts.drafts?.[params.pull_number] ?? false,
						node_id: `node_${params.pull_number}`,
					},
				}),
				listReviews: async (params: { pull_number: number }) => ({
					data: (opts.reviews?.[params.pull_number] ?? []).map((r) => ({
						state: r.state,
						body: r.body ?? "",
						user: { login: r.user },
					})),
				}),
				listReviewComments: async () => ({ data: [] }),
			},
			checks: {
				listForRef: async (params: { ref: string }) => ({
					data: { check_runs: opts.ci?.[params.ref] ?? [] },
				}),
			},
		} as unknown as ForgeGitHubClient["rest"],
		graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
			if (query.includes("markPullRequestReadyForReview")) {
				const id = String(variables?.["id"] ?? "");
				undrafted.push(parseInt(id.replace("node_", ""), 10));
				return { markPullRequestReadyForReview: { pullRequest: { id } } } as T;
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
		undrafted,
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

	it("moves In progress items with a green-CI linked PR to In review", async () => {
		const client = mockClient({
			board: [{ number: 4, title: "working", state: "OPEN", status: "In progress" }],
			issues: { 4: { state: "open", body: "" } },
			linkedPr: { 4: 17 },
			drafts: { 17: true },
			ci: { abc123: [{ status: "completed", conclusion: "success" }] },
		});
		const report = await syncBoard(client, baseConfig);
		expect(report.toReview).toEqual([4]);
		expect(client.movedCards).toEqual([{ issue: 4, status: "in_review" }]);
		expect(client.undrafted).toEqual([17]);
	});

	it("leaves In progress items whose CI is not green or PR missing", async () => {
		const client = mockClient({
			board: [
				{ number: 4, title: "pending ci", state: "OPEN", status: "In progress" },
				{ number: 8, title: "no pr yet", state: "OPEN", status: "In progress" },
				{ number: 9, title: "ready", state: "OPEN", status: "Ready" },
			],
			issues: { 4: { state: "open", body: "" }, 8: { state: "open", body: "" } },
			linkedPr: { 4: 17 },
			ci: { abc123: [{ status: "in_progress", conclusion: null }] },
		});
		const report = await syncBoard(client, baseConfig);
		expect(report).toEqual({ promoted: [], done: [], toReview: [], rework: [], blockedCount: 0, cleanup: null });
		expect(client.movedCards).toEqual([]);
		expect(client.undrafted).toEqual([]);
	});

	it("bounces In review items back to In progress on requested changes", async () => {
		const client = mockClient({
			board: [{ number: 4, title: "bounced", state: "OPEN", status: "In review" }],
			issues: { 4: { state: "open", body: "" } },
			linkedPr: { 4: 17 },
			reviews: { 17: [{ state: "CHANGES_REQUESTED", user: "mjaric", body: "fix the edge case" }] },
		});
		const report = await syncBoard(client, baseConfig);
		expect(report.rework).toEqual([4]);
		expect(client.movedCards).toEqual([{ issue: 4, status: "in_progress" }]);
	});

	it("does not bounce on APPROVED or COMMENTED reviews", async () => {
		const client = mockClient({
			board: [{ number: 4, title: "approved", state: "OPEN", status: "In review" }],
			issues: { 4: { state: "open", body: "" } },
			linkedPr: { 4: 17 },
			reviews: {
				17: [
					{ state: "CHANGES_REQUESTED", user: "mjaric" },
					{ state: "APPROVED", user: "mjaric" },
				],
			},
		});
		const report = await syncBoard(client, baseConfig);
		expect(report.rework).toEqual([]);
		expect(client.movedCards).toEqual([]);
	});

	it("passes merged head refs to local cleanup when cwd is given", async () => {
		const client = mockClient({
			board: [{ number: 5, title: "merged", state: "CLOSED", status: "In review" }],
			linkedPr: { 5: 17 },
			headRefs: { 17: "impl/5-thing" },
		});
		// Non-git dir → cleanup returns the NO_REPO report; the point is it runs.
		const report = await syncBoard(client, baseConfig, "/tmp");
		expect(report.done).toEqual([5]);
		expect(report.cleanup).not.toBeNull();
	});

	it("skips cleanup when nothing merged", async () => {
		const client = mockClient({ board: [] });
		const report = await syncBoard(client, baseConfig, "/tmp");
		expect(report.cleanup).toBeNull();
	});
});

describe("formatSyncReport", () => {
	it("lists promoted, review-bound, rework, and done issues", () => {
		const out = formatSyncReport({
			promoted: [1, 2],
			done: [5],
			toReview: [4],
			rework: [6],
			blockedCount: 3,
			cleanup: null,
		});
		expect(out).toContain("#1, #2");
		expect(out).toContain("#4");
		expect(out).toContain("#6");
		expect(out).toContain("#5");
		expect(out).toContain("3");
	});
});
