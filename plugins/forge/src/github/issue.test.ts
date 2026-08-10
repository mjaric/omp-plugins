import { describe, expect, it } from "bun:test";
import { getIssueDetail, parseAcceptance, parseBodyBlockers } from "./issue";
import type { ForgeGitHubClient } from "./client";

describe("parseAcceptance", () => {
	it("returns complete when all criteria are written", () => {
		const body = `
## Scope
Do the thing.

## Acceptance
- [x] REQ-001: verified by \`test_foo\`
- [x] REQ-002: verified by \`test_bar\`
- [x] Gate: cargo test, clippy
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("returns complete when criteria are written but unchecked", () => {
		const body = `
## Acceptance
- [x] REQ-001: verified by \`test_foo\`
- [ ] REQ-002: verified by \`test_bar\`
- [ ] Gate: cargo test
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("returns incomplete with empty criterion bullets", () => {
		const body = `
## Acceptance
- [x] REQ-001: verified by \`test_foo\`
- [ ]
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(false);
		expect(result.missing).toEqual(["criterion 2 is empty"]);
	});

	it("returns incomplete when the section has no criteria", () => {
		const body = `
## Acceptance

Prose only.
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(false);
		expect(result.missing).toEqual(["no acceptance criteria written"]);
	});

	it("returns incomplete when no acceptance section exists", () => {
		const body = `
## Scope
Some scope.

## Dependencies
None.
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(false);
		expect(result.missing).toEqual(["no Acceptance section found"]);
	});

	it("stops at next heading", () => {
		const body = `
## Acceptance
- [x] REQ-001
- [ ]

## Dependencies
- [ ] This should not be counted
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(false);
		expect(result.missing).toEqual(["criterion 2 is empty"]);
	});
});

describe("parseBodyBlockers", () => {
	it("extracts single blocker", () => {
		const blockers = parseBodyBlockers("Blocked by #12\n");
		expect(blockers).toEqual([12]);
	});

	it("extracts multiple blockers from comma list", () => {
		const blockers = parseBodyBlockers("Blocked by #12, #13, #14\n");
		expect(blockers).toEqual([12, 13, 14]);
	});

	it("matches case-insensitively and with hyphen", () => {
		const blockers1 = parseBodyBlockers("blocked by #5");
		const blockers2 = parseBodyBlockers("blocked-by #5");
		const blockers3 = parseBodyBlockers("Depends on #5");
		expect(blockers1).toEqual([5]);
		expect(blockers2).toEqual([5]);
		expect(blockers3).toEqual([5]);
	});

	it("returns empty when no blocker text", () => {
		const blockers = parseBodyBlockers("No dependencies.\n");
		expect(blockers).toEqual([]);
	});
});

describe("getIssueDetail", () => {
	/** Mock client: issues keyed by number, state + body configurable. */
	function mockClient(
		issues: Record<number, { state: string; body: string }>,
		native?: Record<number, Array<{ number: number; state: string }>>,
	): ForgeGitHubClient {
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
					return { repository: { issue: { blockedBy: { nodes: native?.[num] ?? [] } } } } as T;
				}
				throw new Error("unexpected graphql");
			},
		};
	}

	const bodyWithBlocker = "Blocked by #1\n\n## Acceptance\n- [x] REQ-1\n";

	it("derives blockers and acceptance from one fetch", async () => {
		const client = mockClient({
			10: { state: "open", body: bodyWithBlocker },
			1: { state: "open", body: "" },
		});
		const detail = await getIssueDetail(client, "o/r", 10);
		expect(detail.blockers.openBlockers).toEqual([1]);
		expect(detail.acceptance.complete).toBe(true);
	});

	it("treats unfetchable blockers as open (conservative)", async () => {
		const client: ForgeGitHubClient = {
			rest: {
				issues: {
					get: async (params: { issue_number: number }) => {
						if (params.issue_number === 10) {
							return { data: { state: "open", body: "Blocked by #99" } };
						}
						throw new Error("404");
					},
				},
			} as unknown as ForgeGitHubClient["rest"],
			graphql: async () => {
				throw new Error("unexpected graphql");
			},
		};
		const detail = await getIssueDetail(client, "o/r", 10);
		expect(detail.blockers.openBlockers).toEqual([99]);
	});

	it("reports empty acceptance criteria as incomplete", async () => {
		const client = mockClient({
			11: { state: "open", body: "## Acceptance\n- [ ] REQ-2\n- [ ]\n" },
		});
		const detail = await getIssueDetail(client, "o/r", 11);
		expect(detail.blockers.openBlockers).toEqual([]);
		expect(detail.acceptance.complete).toBe(false);
		expect(detail.acceptance.missing).toEqual(["criterion 2 is empty"]);
	});

	it("unions native blocked-by relationships with body text", async () => {
		const client = mockClient(
			{
				10: { state: "open", body: "Blocked by #1\n\n## Acceptance\n- [ ] REQ-2\n" },
				1: { state: "open", body: "" },
				2: { state: "closed", body: "" },
			},
			{ 10: [{ number: 2, state: "CLOSED" }, { number: 1, state: "OPEN" }] },
		);
		const detail = await getIssueDetail(client, "o/r", 10);
		expect(detail.blockers.allBlockers).toEqual([2, 1]);
		expect(detail.blockers.openBlockers).toEqual([1]);
		expect(detail.acceptance.complete).toBe(true);
	});
});
