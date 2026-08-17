import { describe, expect, it } from "bun:test";
import { buildForgePlan, capDispatchable, formatForgePlan, summarizeMilestones, type ForgePlan } from "./plan";
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

interface IssueSpec {
	state: string;
	body: string;
}

interface BoardItemSpec {
	number: number;
	title: string;
	state: string;
	status: string;
	milestone?: string | null;
}

/** Mock client: board via graphql, issues/PRs/checks via rest. */
function mockClient(opts: {
	board: BoardItemSpec[];
	issues?: Record<number, IssueSpec>;
	linkedPr?: Record<number, number>;
	ci?: Record<string, Array<{ status: string; conclusion: string | null }>>;
	native?: Record<number, Array<{ number: number; state: string }>>;
}): ForgeGitHubClient {
	const issues = opts.issues ?? {};
	return {
		rest: {
			issues: {
				get: async (params: { issue_number: number }) => ({
					data: issues[params.issue_number] ?? { state: "closed", body: "" },
				}),
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
				get: async () => ({ data: { head: { sha: "abc123" } } }),
			},
			checks: {
				listForRef: async (params: { ref: string }) => ({
					data: { check_runs: opts.ci?.[params.ref] ?? [] },
				}),
			},
		} as unknown as ForgeGitHubClient["rest"],
		graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
			if (query.includes("blockedBy")) {
				const num = Number(variables?.["number"]);
				return { repository: { issue: { blockedBy: { nodes: opts.native?.[num] ?? [] } } } } as T;
			}
			return {
				node: {
					owner: { __typename: "User", login: "mjaric" },
					id: "PVT_test123",
					items: {
						nodes: opts.board.map((item) => ({
							id: `item_${item.number}`,
							content: {
								number: item.number,
								title: item.title,
								state: item.state,
								milestone: item.milestone !== undefined ? { title: item.milestone } : null,
							},
							fieldValues: { nodes: [{ name: item.status, field: { name: "Status" } }] },
						})),
					},
				},
			} as T;
		},
	};
}

const completeBody = "## Acceptance\n- [x] REQ-1\n";
const writtenBody = "## Acceptance\n- [ ] REQ-1\n";
const noAcceptanceBody = "## Scope\nDo the thing.\n";

describe("buildForgePlan", () => {
	it("dispatches Ready items whose blockers are closed", async () => {
		const client = mockClient({
			board: [
				{ number: 1, title: "ready issue", state: "OPEN", status: "Ready" },
				{ number: 2, title: "ready but reopened", state: "OPEN", status: "Ready" },
			],
			issues: {
				1: { state: "open", body: "Blocked by #7\n" + completeBody },
				2: { state: "open", body: "Blocked by #8\n" + completeBody },
				7: { state: "closed", body: "" },
				8: { state: "open", body: "" },
			},
		});
		const plan = await buildForgePlan(client, baseConfig);
		expect(plan.dispatchable.map((d) => d.issue)).toEqual([1]);
		expect(plan.blocked).toEqual([
			{ issue: 2, title: "ready but reopened", status: "Ready", openBlockers: [8] },
		]);
	});

	it("classifies Backlog items as blocked / not-ready / promotable", async () => {
		const client = mockClient({
			board: [
				{ number: 1, title: "blocked", state: "OPEN", status: "Backlog" },
				{ number: 2, title: "no acceptance", state: "OPEN", status: "Backlog" },
				{ number: 3, title: "eligible", state: "OPEN", status: "Backlog" },
			],
			issues: {
				1: { state: "open", body: `Blocked by #7\n\n${completeBody}` },
				2: { state: "open", body: noAcceptanceBody },
				3: { state: "open", body: writtenBody },
				7: { state: "open", body: "" },
			},
		});
		const plan = await buildForgePlan(client, baseConfig);
		expect(plan.blocked.map((b) => ({ issue: b.issue, openBlockers: b.openBlockers }))).toEqual([
			{ issue: 1, openBlockers: [7] },
		]);
		expect(plan.notReady.map((n) => n.issue)).toEqual([2]);
		expect(plan.promotable.map((p) => p.issue)).toEqual([3]);
	});

	it("reads native blocked-by relationships for Backlog classification", async () => {
		const client = mockClient({
			board: [
				{ number: 1, title: "natively blocked", state: "OPEN", status: "Backlog" },
				{ number: 2, title: "natively unblocked", state: "OPEN", status: "Backlog" },
			],
			issues: {
				1: { state: "open", body: writtenBody },
				2: { state: "open", body: writtenBody },
				7: { state: "open", body: "" },
				8: { state: "closed", body: "" },
			},
			native: {
				1: [{ number: 7, state: "OPEN" }],
				2: [{ number: 8, state: "CLOSED" }],
			},
		});
		const plan = await buildForgePlan(client, baseConfig);
		expect(plan.blocked.map((b) => ({ issue: b.issue, openBlockers: b.openBlockers }))).toEqual([
			{ issue: 1, openBlockers: [7] },
		]);
		expect(plan.promotable.map((p) => p.issue)).toEqual([2]);
	});

	it("collects In review items with linked PR and CI state", async () => {
		const client = mockClient({
			board: [{ number: 5, title: "review me", state: "OPEN", status: "In review" }],
			issues: { 5: { state: "open", body: "" } },
			linkedPr: { 5: 12 },
			ci: { abc123: [{ status: "completed", conclusion: "success" }] },
		});
		const plan = await buildForgePlan(client, baseConfig);
		expect(plan.reviewable).toEqual([{ issue: 5, title: "review me", pr: 12, ci: "pass" }]);
	});

	it("skips In review items without a linked PR", async () => {
		const client = mockClient({
			board: [{ number: 5, title: "no pr yet", state: "OPEN", status: "In review" }],
			issues: { 5: { state: "open", body: "" } },
		});
		const plan = await buildForgePlan(client, baseConfig);
		expect(plan.reviewable).toEqual([]);
		expect(plan.idle).toBe(true);
	});

	it("flags needs-decision issues regardless of status", async () => {
		const client = mockClient({
			board: [
				{ number: 9, title: "needs-decision: storage format", state: "OPEN", status: "Backlog" },
			],
			issues: { 9: { state: "open", body: completeBody } },
		});
		const plan = await buildForgePlan(client, baseConfig);
		expect(plan.needsDecision.map((n) => n.issue)).toEqual([9]);
	});

	it("ignores closed items", async () => {
		const client = mockClient({
			board: [{ number: 1, title: "done", state: "CLOSED", status: "Ready" }],
		});
		const plan = await buildForgePlan(client, baseConfig);
		expect(plan.dispatchable).toEqual([]);
		expect(plan.blocked).toEqual([]);
		expect(plan.idle).toBe(true);
	});

	it("reports in-progress numbers", async () => {
		const client = mockClient({
			board: [{ number: 4, title: "working", state: "OPEN", status: "In progress" }],
		});
		const plan = await buildForgePlan(client, baseConfig);
		expect(plan.inProgress).toEqual([4]);
		expect(plan.idle).toBe(false);
	});

	it("summarizes milestone completion", async () => {
		const client = mockClient({
			board: [
				{ number: 1, title: "a", state: "CLOSED", status: "Done", milestone: "Slice 1" },
				{ number: 2, title: "b", state: "OPEN", status: "Backlog", milestone: "Slice 1" },
				{ number: 3, title: "c", state: "CLOSED", status: "Done", milestone: "Slice 0" },
			],
			issues: { 2: { state: "open", body: completeBody } },
		});
		const plan = await buildForgePlan(client, baseConfig);
		const slice0 = plan.milestones.find((m) => m.name === "Slice 0");
		const slice1 = plan.milestones.find((m) => m.name === "Slice 1");
		expect(slice0).toEqual({ name: "Slice 0", open: 0, done: 1, complete: true });
		expect(slice1).toEqual({ name: "Slice 1", open: 1, done: 1, complete: false });
	});
});

describe("capDispatchable", () => {
	const items = [1, 2, 3, 4, 5].map((n) => ({ issue: n, title: `t${n}`, milestone: null }));

	it("caps at maxWorkers", () => {
		expect(capDispatchable(items, 3).map((d) => d.issue)).toEqual([1, 2, 3]);
	});

	it("keeps all when under the cap", () => {
		expect(capDispatchable(items, 10)).toHaveLength(5);
	});
});

describe("summarizeMilestones", () => {
	it("skips items without a milestone", () => {
		const summaries = summarizeMilestones([
			{ issueNumber: 1, title: "t", state: "OPEN", status: "Backlog", slice: null, milestone: null },
		]);
		expect(summaries).toEqual([]);
	});

	it("marks a milestone complete only when it has done items and no open ones", () => {
		const summaries = summarizeMilestones([
			{ issueNumber: 1, title: "t", state: "CLOSED", status: "Done", slice: null, milestone: "M" },
			{ issueNumber: 2, title: "t", state: "CLOSED", status: "Done", slice: null, milestone: "M" },
		]);
		expect(summaries).toEqual([{ name: "M", open: 0, done: 2, complete: true }]);
	});
});

describe("formatForgePlan", () => {
	const emptyPlan: ForgePlan = {
		repo: "o/r",
		dispatchable: [],
		blocked: [],
		notReady: [],
		promotable: [],
		reviewable: [],
		rework: [],
		inProgress: [],
		needsDecision: [],
		milestones: [],
		idle: true,
	};

	it("marks idle boards", () => {
		expect(formatForgePlan(emptyPlan)).toContain("idle");
	});

	it("lists dispatchable issues and milestone lines", () => {
		const plan: ForgePlan = {
			...emptyPlan,
			dispatchable: [{ issue: 3, title: "t", milestone: null }],
			milestones: [{ name: "Slice 1", open: 1, done: 2, complete: false }],
			idle: false,
		};
		const out = formatForgePlan(plan);
		expect(out).toContain("Dispatchable: #3");
		expect(out).toContain(`Milestone "Slice 1": 2 done, 1 open`);
		expect(out).not.toContain("idle");
	});
});
