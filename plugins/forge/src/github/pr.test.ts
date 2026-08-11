import { describe, expect, it } from "bun:test";
import { buildReviewContract, formatReviewContract, getReviewFeedback } from "./pr";
import type { ForgeGitHubClient } from "./client";

describe("buildReviewContract", () => {
	it("extracts sections by heading", () => {
		const body = `
## Scope
Create the thing.

## Spec references
- REQ-001

## Acceptance
- [ ] REQ-001: verified by \`test_thing\`
`;
		const contract = buildReviewContract(42, body);
		expect(contract.issueNumber).toBe(42);
		expect(contract.scope).toContain("Create the thing");
		expect(contract.specReferences).toContain("REQ-001");
		expect(contract.acceptance).toContain("test_thing");
	});

	it("handles missing sections gracefully", () => {
		const body = "Just some text, no sections.";
		const contract = buildReviewContract(1, body);
		expect(contract.scope).toBe("(no scope section)");
		expect(contract.specReferences).toBe("(no spec references)");
		expect(contract.acceptance).toBe("(no acceptance section)");
	});
});

describe("formatReviewContract", () => {
	it("produces a formatted string with all sections", () => {
		const contract = {
			issueNumber: 7,
			scope: "Do X.",
			specReferences: "REQ-007",
			acceptance: "- [ ] REQ-007: test",
		};
		const formatted = formatReviewContract(contract);
		expect(formatted).toContain("Issue #7");
		expect(formatted).toContain("### Scope");
		expect(formatted).toContain("Do X.");
		expect(formatted).toContain("### Acceptance criteria");
		expect(formatted).toContain("REQ-007: test");
		expect(formatted).not.toContain("Human review feedback");
	});

	it("appends human feedback when provided", () => {
		const contract = { issueNumber: 7, scope: "s", specReferences: "r", acceptance: "a" };
		const formatted = formatReviewContract(contract, {
			requestedChanges: true,
			reviews: [{ author: "mjaric", state: "CHANGES_REQUESTED", body: "edge case unhandled" }],
			comments: [{ author: "mjaric", path: "src/a.rs", body: "rename this" }],
		});
		expect(formatted).toContain("### Human review feedback");
		expect(formatted).toContain("Requested changes by: @mjaric");
		expect(formatted).toContain("edge case unhandled");
		expect(formatted).toContain("on src/a.rs");
	});
});

/** Mock client: reviews + comments via rest. */
function feedbackClient(opts: {
	reviews?: Array<{ state: string; user: string; body?: string }>;
	reviewComments?: Array<{ user: string; path?: string; body?: string }>;
	comments?: Array<{ user: string; body?: string }>;
}): ForgeGitHubClient {
	return {
		rest: {
			pulls: {
				listReviews: async () => ({
					data: (opts.reviews ?? []).map((r) => ({
						state: r.state,
						body: r.body ?? "",
						user: { login: r.user },
					})),
				}),
				listReviewComments: async () => ({
					data: (opts.reviewComments ?? []).map((c) => ({
						body: c.body ?? "",
						path: c.path,
						user: { login: c.user },
					})),
				}),
			},
			issues: {
				listComments: async () => ({
					data: (opts.comments ?? []).map((c) => ({
						body: c.body ?? "",
						user: { login: c.user },
					})),
				}),
			},
		} as unknown as ForgeGitHubClient["rest"],
		graphql: async <T>() => ({} as T),
	};
}

describe("getReviewFeedback", () => {
	it("flags requested changes from the latest verdict per reviewer", async () => {
		const client = feedbackClient({
			reviews: [
				{ state: "CHANGES_REQUESTED", user: "mjaric", body: "fix it" },
				{ state: "APPROVED", user: "mjaric" },
			],
		});
		const feedback = await getReviewFeedback(client, "mjaric/smith", 19);
		expect(feedback.requestedChanges).toBe(false);
		expect(feedback.reviews).toEqual([{ author: "mjaric", state: "APPROVED", body: "" }]);
	});

	it("keeps changes-requested when no later verdict supersedes it", async () => {
		const client = feedbackClient({
			reviews: [{ state: "CHANGES_REQUESTED", user: "mjaric", body: "fix it" }],
			reviewComments: [{ user: "mjaric", path: "src/a.rs", body: "rename" }],
			comments: [{ user: "mjaric", body: "also this" }],
		});
		const feedback = await getReviewFeedback(client, "mjaric/smith", 19);
		expect(feedback.requestedChanges).toBe(true);
		expect(feedback.comments).toEqual([
			{ author: "mjaric", path: "src/a.rs", body: "rename" },
			{ author: "mjaric", path: null, body: "also this" },
		]);
	});

	it("ignores COMMENTED reviews as verdicts", async () => {
		const client = feedbackClient({
			reviews: [
				{ state: "APPROVED", user: "mjaric" },
				{ state: "COMMENTED", user: "mjaric", body: "nit" },
			],
		});
		const feedback = await getReviewFeedback(client, "mjaric/smith", 19);
		expect(feedback.requestedChanges).toBe(false);
		expect(feedback.reviews).toEqual([{ author: "mjaric", state: "APPROVED", body: "" }]);
	});
});
