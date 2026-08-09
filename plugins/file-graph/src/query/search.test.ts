import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../types";
import { GraphStore, type FileUpsertInput } from "../store/store";
import { ZKSRC_PROFILE } from "../profiles/profiles";
import { parseMarkdown } from "../parser/parse";
import { search, suggest } from "./search";

function fixture(path: string, content: string, profile: Profile = ZKSRC_PROFILE): FileUpsertInput {
	return { parsed: parseMarkdown(content, path, profile), mtimeMs: 1000, contentHash: `h-${path}` };
}

describe("search — ranking order", () => {
	let workspace: string;
	let store: GraphStore;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "fg-rank-"));
		store = GraphStore.open(workspace, ZKSRC_PROFILE);
		store.upsertFile(fixture("rich.md", "---\ntitle: Trust Registry\npurpose: Trust levels and gates.\n---\n\n# Trust Verification"));
		store.upsertFile(fixture("minor.md", "---\npurpose: trust mentioned once\n---\n\n# Other Topic"));
		store.upsertFile(fixture("none.md", "---\ntitle: Unrelated\n---\n\n# No Match Here"));
		store.resolveDefinitionSites();
	});

	afterEach(() => {
		store.close();
		rmSync(workspace, { recursive: true, force: true });
	});

	it("ranks files with more term matches higher", async () => {
		const hits = await search(store, "trust", { expandGraph: false });
		expect(hits.length).toBeGreaterThanOrEqual(2);
		expect(hits[0]!.path).toBe("rich.md");
		expect(hits[1]!.path).toBe("minor.md");
	});

	it("excludes files with no matches", async () => {
		const hits = await search(store, "trust", { expandGraph: false });
		expect(hits.find(h => h.path === "none.md")).toBeUndefined();
	});

	it("returns empty array for empty query", async () => {
		expect(await search(store, "", {})).toEqual([]);
	});

	it("returns empty array for no matches", async () => {
		expect(await search(store, "zzznonexistent", {})).toEqual([]);
	});
});

describe("search — graph expansion", () => {
	let workspace: string;
	let store: GraphStore;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "fg-graph-"));
		store = GraphStore.open(workspace, ZKSRC_PROFILE);
		store.upsertFile(fixture("defs.md", "---\ntitle: Definitions\n---\n\n# C4: Core Claim\n\n[C4]"));
		store.upsertFile(fixture("beta.md", "---\ntitle: Beta Feature\n---\n\n# Beta\n\n[C4]"));
		store.resolveDefinitionSites();
	});

	afterEach(() => {
		store.close();
		rmSync(workspace, { recursive: true, force: true });
	});

	it("boosts files connected via shared entities", async () => {
		const hits = await search(store, "beta", { expandGraph: true });
		expect(hits.some(h => h.path === "beta.md")).toBe(true);
		expect(hits.some(h => h.path === "defs.md")).toBe(true);
	});

	it("disabling expansion excludes connected-only files", async () => {
		const hits = await search(store, "beta", { expandGraph: false });
		expect(hits.some(h => h.path === "beta.md")).toBe(true);
		expect(hits.find(h => h.path === "defs.md")).toBeUndefined();
	});
});

describe("search — rerank-disabled path", () => {
	it("returns results without rerank by default", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "fg-rr-"));
		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		store.upsertFile(fixture("a.md", "---\ntitle: Alpha Doc\n---\n\n# Alpha Section"));
		store.resolveDefinitionSites();

		const hits = await search(store, "alpha", {});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.path).toBe("a.md");

		store.close();
		rmSync(workspace, { recursive: true, force: true });
	});
});

describe("suggest", () => {
	it("returns candidates relevant to a prompt", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "fg-sug-"));
		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		store.upsertFile(fixture("doc.md", "---\ntitle: Important Doc\n---\n\n# Important Topic"));
		store.resolveDefinitionSites();

		const hits = await suggest(store, "important", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.path).toBe("doc.md");

		store.close();
		rmSync(workspace, { recursive: true, force: true });
	});
});
