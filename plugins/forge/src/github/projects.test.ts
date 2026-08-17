import { describe, expect, it } from "bun:test";
import {
	assertBoardOwnership,
	discoverProjectsForRepo,
	fetchProjectOwner,
	ownershipMatches,
} from "./projects";
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

function mockClient(responses: Record<string, unknown>): ForgeGitHubClient {
	return {
		rest: {} as ForgeGitHubClient["rest"],
		graphql: async <T>(query: string): Promise<T> => {
			if (query.includes("repository(owner:")) {
				return responses["discovery"] as T;
			}
			if (query.includes("node(id:")) {
				return responses["owner"] as T;
			}
			throw new Error("unexpected graphql");
		},
	};
}

describe("projects.discoverProjectsForRepo", () => {
	it("lists org boards with the linked board first and canonical repo", async () => {
		const client = mockClient({
			discovery: {
				repository: {
					name: "industry-kb",
					owner: {
						__typename: "Organization",
						login: "DreamforgeRS",
						projectsV2: {
							nodes: [
								{ id: "PVT_a", title: "Board A" },
								{ id: "PVT_linked", title: "DreamTools Industry KB" },
								{ id: "PVT_b", title: "Board B" },
							],
						},
					},
					projectsV2: { nodes: [{ id: "PVT_linked", title: "DreamTools Industry KB" }] },
				},
			},
		});

		const result = await discoverProjectsForRepo(client, "DreamforgeRS", "industry-kb");

		expect(result.ownership).toEqual({ login: "DreamforgeRS", kind: "org" });
		expect(result.repo).toBe("DreamforgeRS/industry-kb");
		expect(result.projects.map((p) => p.id)).toEqual(["PVT_linked", "PVT_a", "PVT_b"]);
		expect(result.projects.filter((p) => p.linked)).toHaveLength(1);
		expect(result.projects[0]).toEqual({
			id: "PVT_linked",
			title: "DreamTools Industry KB",
			linked: true,
		});
	});

	it("resolves personal boards for user-owned repos", async () => {
		const client = mockClient({
			discovery: {
				repository: {
					name: "smith",
					owner: {
						__typename: "User",
						login: "mjaric",
						projectsV2: { nodes: [{ id: "PVT_other", title: "Other" }, { id: "PVT_mine", title: "Smith KB" }] },
					},
					projectsV2: { nodes: [{ id: "PVT_mine", title: "Smith KB" }] },
				},
			},
		});

		const result = await discoverProjectsForRepo(client, "mjaric", "smith");

		expect(result.ownership).toEqual({ login: "mjaric", kind: "user" });
		expect(result.repo).toBe("mjaric/smith");
		expect(result.projects.map((p) => p.id)).toEqual(["PVT_mine", "PVT_other"]);
	});

	it("returns empty discovery when the repository is null", async () => {
		const client = mockClient({
			discovery: { repository: null },
		});

		const result = await discoverProjectsForRepo(client, "Nobody", "ghost");

		expect(result).toEqual({ ownership: null, repo: null, projects: [] });
	});
});

describe("projects.ownershipMatches", () => {
	it("compares the repo owner case-insensitively", () => {
		expect(ownershipMatches("mjaric/smith", "MJARIC")).toBe(true);
		expect(ownershipMatches("DreamforgeRS/industry-kb", "dreamforgers")).toBe(true);
	});

	it("rejects a different owner", () => {
		expect(ownershipMatches("mjaric/smith", "DreamforgeRS")).toBe(false);
		expect(ownershipMatches("smith", "mjaric")).toBe(false);
	});
});

describe("projects.assertBoardOwnership", () => {
	it("passes when the board owner matches the repo owner", () => {
		expect(() =>
			assertBoardOwnership(baseConfig, { __typename: "User", login: "mjaric" }),
		).not.toThrow();
	});

	it("throws naming both owners on mismatch", () => {
		expect(() =>
			assertBoardOwnership(baseConfig, { __typename: "Organization", login: "DreamforgeRS" }),
		).toThrow(/ownership mismatch.*DreamforgeRS.*mjaric\/smith/);
	});

	it("throws not reachable when the owner is absent", () => {
		expect(() => assertBoardOwnership(baseConfig, undefined)).toThrow(
			/board PVT_test123 not reachable/,
		);
	});
});

describe("projects.fetchProjectOwner", () => {
	it("parses a User owner", async () => {
		const client = mockClient({
			owner: { node: { owner: { __typename: "User", login: "mjaric" } } },
		});

		expect(await fetchProjectOwner(client, "PVT_test123")).toEqual({
			login: "mjaric",
			kind: "user",
		});
	});

	it("parses an Organization owner", async () => {
		const client = mockClient({
			owner: { node: { owner: { __typename: "Organization", login: "DreamforgeRS" } } },
		});

		expect(await fetchProjectOwner(client, "PVT_test123")).toEqual({
			login: "DreamforgeRS",
			kind: "org",
		});
	});

	it("returns null when the node is unreachable", async () => {
		const client = mockClient({ owner: { node: null } });

		expect(await fetchProjectOwner(client, "PVT_gone")).toBeNull();
	});
});
