import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../workspace";
import { ZKSRC_PROFILE } from "../profiles/profiles";
import { parseMarkdown } from "../parser/parse";
import { reindex } from "../indexer";
import { GraphStore } from "./store";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "fg-test-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function writeMd(name: string, content: string, mtimeSec: number): void {
	const p = join(workspace, name);
	writeFileSync(p, content);
	utimesSync(p, mtimeSec, mtimeSec);
}

describe("GraphStore — transactional per-file replace", () => {
	it("replaces headings when a file is re-upserted", () => {
		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		const hash1 = contentHash("# Old\n## Sub");
		store.upsertFile({ parsed: parseMarkdown("# Old\n## Sub", "a.md", ZKSRC_PROFILE), mtimeMs: 1000, contentHash: hash1 });

		const row1 = store.getFileByPath("a.md")!;
		expect(store.listHeadings(row1.id)).toHaveLength(2);

		const hash2 = contentHash("# New\n## X\n## Y\n## Z");
		store.upsertFile({ parsed: parseMarkdown("# New\n## X\n## Y\n## Z", "a.md", ZKSRC_PROFILE), mtimeMs: 2000, contentHash: hash2 });

		const row2 = store.getFileByPath("a.md")!;
		const headings = store.listHeadings(row2.id);
		expect(headings).toHaveLength(4);
		expect(headings[0]!.text).toBe("New");
		store.close();
	});

	it("replaces relations without leaving duplicates", () => {
		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		const content1 = "---\nrelations:\n  - \"[C1] gates [C2]\"\n---\n\nBody";
		store.upsertFile({ parsed: parseMarkdown(content1, "a.md", ZKSRC_PROFILE), mtimeMs: 1000, contentHash: "h1" });

		const row1 = store.getFileByPath("a.md")!;
		expect(store.getRelationsForFile(row1.id)).toHaveLength(1);

		const content2 = "---\nrelations:\n  - \"[C3] gates [C4]\"\n---\n\nBody";
		store.upsertFile({ parsed: parseMarkdown(content2, "a.md", ZKSRC_PROFILE), mtimeMs: 2000, contentHash: "h2" });

		const row2 = store.getFileByPath("a.md")!;
		const rels = store.getRelationsForFile(row2.id);
		expect(rels).toHaveLength(1);
		expect(rels[0]!.type).toBe("gates");
		store.close();
	});
});

describe("GraphStore — incremental reindex idempotency", () => {
	it("reports unchanged on second reindex with no file changes", () => {
		writeMd("a.md", "---\ntitle: A\npurpose: Alpha.\n---\n\n# Heading\n\n[C4]", 1000);
		writeMd("b.md", "---\ntitle: B\npurpose: Beta.\n---\n\n# B\n", 1000);

		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		const first = reindex(store, workspace, ZKSRC_PROFILE);
		expect(first.added).toBe(2);

		const second = reindex(store, workspace, ZKSRC_PROFILE);
		expect(second.added).toBe(0);
		expect(second.updated).toBe(0);
		expect(second.unchanged).toBe(2);
		store.close();
	});

	it("detects updated files on content change", () => {
		writeMd("a.md", "---\ntitle: Old\n---\n\nBody", 1000);
		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		reindex(store, workspace, ZKSRC_PROFILE);

		writeMd("a.md", "---\ntitle: New\n---\n\nChanged body", 2000);
		const result = reindex(store, workspace, ZKSRC_PROFILE);
		expect(result.updated).toBe(1);
		expect(store.getFileByPath("a.md")!.title).toBe("New");
		store.close();
	});

	it("deletes files removed from the workspace", () => {
		writeMd("a.md", "# A", 1000);
		writeMd("b.md", "# B", 1000);
		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		reindex(store, workspace, ZKSRC_PROFILE);
		expect(store.listFiles()).toHaveLength(2);

		rmSync(join(workspace, "b.md"));
		const result = reindex(store, workspace, ZKSRC_PROFILE);
		expect(result.deleted).toBe(1);
		expect(store.listFiles()).toHaveLength(1);
		store.close();
	});
});

describe("GraphStore — resolution and dangling refs", () => {
	it("resolves definition sites to files", () => {
		writeMd(
			"defs.md",
			"# C4: Trust Claim\n\nThe main claim.\n\n**SP7** is a spike.",
			1000,
		);
		writeMd("refs.md", "See [C4] and [SP7] here.", 1000);

		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		reindex(store, workspace, ZKSRC_PROFILE);

		const c4 = store.getEntityByName("C4")!;
		expect(c4.defFileId).not.toBeNull();
		const sp7 = store.getEntityByName("SP7")!;
		expect(sp7.defFileId).not.toBeNull();
		store.close();
	});

	it("preserves dangling entities with no definition site", () => {
		writeMd("refs.md", "See [C99] here — no definition anywhere.", 1000);

		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		reindex(store, workspace, ZKSRC_PROFILE);

		const c99 = store.getEntityByName("C99");
		expect(c99).not.toBeNull();
		expect(c99!.defFileId).toBeNull();
		store.close();
	});

	it("reports missing-purpose files", () => {
		writeMd("with-purpose.md", "---\npurpose: Has one.\n---\n\nBody", 1000);
		writeMd("no-purpose.md", "# No purpose field", 1000);

		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		const report = reindex(store, workspace, ZKSRC_PROFILE);
		void report;
		const files = store.listFiles();
		const missing = files.filter(f => f.purpose === null).map(f => f.path);
		expect(missing).toContain("no-purpose.md");
		expect(missing).not.toContain("with-purpose.md");
		store.close();
	});
});

describe("GraphStore — schema upgrade migration", () => {
	it("re-parses unchanged files after a schema upgrade", () => {
		writeMd("a.md", "# Head\n\nBody", 1000);
		const store = GraphStore.open(workspace, ZKSRC_PROFILE);
		reindex(store, workspace, ZKSRC_PROFILE);

		// Simulate a v1 store: NULL titles and an old schema version.
		const legacy = new Database(store.path);
		legacy.run("UPDATE files SET title = NULL");
		legacy.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
		legacy.close();
		store.close();

		const reopened = GraphStore.open(workspace, ZKSRC_PROFILE);
		expect(reopened.needsReparse()).toBe(true);
		const result = reindex(reopened, workspace, ZKSRC_PROFILE);
		expect(result.updated).toBe(1);
		expect(reopened.getFileByPath("a.md")!.title).toBe("Head");
		expect(reopened.needsReparse()).toBe(false);

		const again = reindex(reopened, workspace, ZKSRC_PROFILE);
		expect(again.unchanged).toBe(1);
		reopened.close();
	});
});
