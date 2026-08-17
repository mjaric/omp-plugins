import { describe, expect, it } from "bun:test";
import { fetchStatusField, getBoardState, moveCard } from "./board";
import type { SingleProjectConfig } from "../config/forge-toml";
import type { ForgeGitHubClient } from "./client";

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

function makeConfig(overrides: Partial<SingleProjectConfig> = {}): SingleProjectConfig {
	return { ...baseConfig, ...overrides };
}

// Capture graphql calls for assertion
type GraphqlCall = { query: string; variables: Record<string, unknown> };
const graphqlCalls: GraphqlCall[] = [];

function mockClient(responses: Record<string, unknown>): ForgeGitHubClient {
	graphqlCalls.length = 0;
	return {
		rest: {} as ForgeGitHubClient["rest"],
		graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
			graphqlCalls.push({ query, variables: variables ?? {} });
			if (query.includes("items(first")) {
				return responses["board"] as T;
			}
			if (query.includes("addProjectV2ItemById")) {
				return responses["add"] as T;
			}
			if (query.includes("updateProjectV2ItemFieldValue")) {
				return responses["update"] as T;
			}
			return responses["default"] as T;
		},
	};
}

describe("board.getBoardState", () => {
	it("parses project items into BoardItem array", async () => {
		const client = mockClient({
			board: {
				node: {
					owner: { __typename: "User", login: "mjaric" },
					items: {
						nodes: [
							{
								content: {
									number: 3,
									title: "smith-core",
									state: "OPEN",
									milestone: { title: "Slice 1" },
								},
								fieldValues: {
									nodes: [
										{},
										{ name: "Backlog", field: { name: "Status" } },
										{ name: "Slice 1", field: { name: "Slice" } },
									],
								},
							},
							{
								content: {
									number: 1,
									title: "Smoke test",
									state: "CLOSED",
									milestone: null,
								},
								fieldValues: {
									nodes: [
										{ name: "Done", field: { name: "Status" } },
									],
								},
							},
						],
					},
				},
			},
		});

		const state = await getBoardState(client, makeConfig());
		expect(state.items).toHaveLength(2);

		const item3 = state.items[0];
		expect(item3?.issueNumber).toBe(3);
		expect(item3?.title).toBe("smith-core");
		expect(item3?.state).toBe("OPEN");
		expect(item3?.status).toBe("Backlog");
		expect(item3?.slice).toBe("Slice 1");
		expect(item3?.milestone).toBe("Slice 1");

		const item1 = state.items[1];
		expect(item1?.status).toBe("Done");
		expect(item1?.slice).toBeNull();
		expect(item1?.milestone).toBeNull();
	});

	it("handles items with missing content (draft issues)", async () => {
		const client = mockClient({
			board: {
				node: {
					owner: { __typename: "User", login: "mjaric" },
					items: {
						nodes: [
							{ content: null, fieldValues: { nodes: [] } },
						],
					},
				},
			},
		});

		const state = await getBoardState(client, makeConfig());
		expect(state.items).toHaveLength(0);
	});

	it("handles empty board", async () => {
		const client = mockClient({
			board: { node: { owner: { __typename: "User", login: "mjaric" }, items: { nodes: [] } } },
		});

		const state = await getBoardState(client, makeConfig());
		expect(state.items).toHaveLength(0);
	});

	it("throws ownership mismatch when the board owner differs from the repo owner", async () => {
		const client = mockClient({
			board: {
				node: {
					owner: { __typename: "Organization", login: "SomeoneElse" },
					items: { nodes: [] },
				},
			},
		});

		await expect(getBoardState(client, makeConfig())).rejects.toThrow(
			/ownership mismatch.*SomeoneElse.*mjaric\/smith/,
		);
	});
});

describe("board.moveCard", () => {
	it("finds item id and updates field", async () => {
		const client = mockClient({
			board: {
				node: {
					owner: { __typename: "User", login: "mjaric" },
					items: {
						nodes: [
							{
								id: "PVTI_item1",
								content: { number: 3, state: "OPEN" },
								fieldValues: { nodes: [] },
							},
						],
					},
				},
			},
			update: {
				updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item1" } },
			},
		});

		await moveCard(client, makeConfig(), 3, "ready");

		expect(graphqlCalls).toHaveLength(2);

		const mutation = graphqlCalls[1];
		expect(mutation?.query).toContain("updateProjectV2ItemFieldValue");
		expect(mutation?.variables).toMatchObject({
			projectId: "PVT_test123",
			itemId: "PVTI_item1",
			fieldId: "PVTSSF_test",
		});
		expect(mutation?.variables).toMatchObject({
			value: { singleSelectOptionId: "opt_ready" },
		});
	});

	it("throws if issue not found on board", async () => {
		const client = mockClient({
			board: { node: { owner: { __typename: "User", login: "mjaric" }, items: { nodes: [] } } },
		});

		expect(moveCard(client, makeConfig(), 999, "ready")).rejects.toThrow("not found on board");
	});
});

describe("board.fetchStatusField", () => {
	/** Real GitHub payload shape: non-single-select fields arrive as empty
	 * objects ({}), so most nodes lack id/name/options entirely. */
	const nodes = [
		{},
		{},
		{
			id: "PVTSSF_status",
			name: "Status",
			options: [
				{ id: "opt_todo", name: "Todo" },
				{ id: "opt_done", name: "Done" },
			],
		},
		{},
		{ id: "PVTSSF_slice", name: "Slice", options: [] },
		{},
	] as Array<{ id?: string; name?: string; options?: Array<{ id: string; name: string }> }>;

	it("returns the Status field, skipping nodes without name/options", async () => {
		const client = mockClient({
			default: { node: { fields: { nodes } } },
		});

		const result = await fetchStatusField(client, "PVT_test");

		expect(result).toEqual({
			fieldId: "PVTSSF_status",
			options: [
				{ id: "opt_todo", name: "Todo" },
				{ id: "opt_done", name: "Done" },
			],
		});
	});

	it("matches the field name case-insensitively", async () => {
		const client = mockClient({
			default: {
				node: {
					fields: {
						nodes: [{ id: "F1", name: "STATUS", options: [{ id: "o", name: "X" }] }],
					},
				},
			},
		});

		const result = await fetchStatusField(client, "PVT_test");
		expect(result?.fieldId).toBe("F1");
	});

	it("returns null when no Status single-select exists", async () => {
		const client = mockClient({
			default: {
				node: {
					fields: {
						nodes: [{}, { id: "F2", name: "Priority", options: [] }],
					},
				},
			},
		});

		expect(await fetchStatusField(client, "PVT_test")).toBeNull();
	});

	it("returns null when the board node is inaccessible", async () => {
		const client = mockClient({ default: { node: null } });

		expect(await fetchStatusField(client, "PVT_gone")).toBeNull();
	});
});
