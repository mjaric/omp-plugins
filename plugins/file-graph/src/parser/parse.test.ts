import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "./parse";
import { GENERIC_PROFILE, ZKSRC_PROFILE } from "../profiles/profiles";

describe("parseMarkdown — frontmatter", () => {
	it("parses title, purpose, entities, and relations", () => {
		const content = "---\ntitle: Claims Registry\npurpose: Source of truth.\nentities: [claim, verification]\nrelations:\n  - \"[SP7] gates [C13]\"\n---\n\n# Body";
		const r = parseMarkdown(content, "claims.md", ZKSRC_PROFILE);
		expect(r.frontmatter.title).toBe("Claims Registry");
		expect(r.frontmatter.purpose).toBe("Source of truth.");
		expect(r.frontmatter.entities).toEqual(["claim", "verification"]);
		expect(r.frontmatter.relations).toEqual(["[SP7] gates [C13]"]);
	});

	it("returns null fields when frontmatter is missing", () => {
		const r = parseMarkdown("# No frontmatter", "test.md", GENERIC_PROFILE);
		expect(r.frontmatter.title).toBeNull();
		expect(r.frontmatter.purpose).toBeNull();
		expect(r.frontmatter.entities).toEqual([]);
	});

	it("handles malformed frontmatter without throwing", () => {
		const r = parseMarkdown("---\ntitle:\nbroken: [unclosed\n---\n\nBody", "test.md", GENERIC_PROFILE);
		expect(r.frontmatter.title).toBeNull();
	});

	it("handles inline-array entities", () => {
		const r = parseMarkdown("---\nentities: [a, b, c]\n---\n\nBody", "t.md", GENERIC_PROFILE);
		expect(r.frontmatter.entities).toEqual(["a", "b", "c"]);
	});
});

describe("parseMarkdown — effective title", () => {
	it("falls back to the first heading when frontmatter has no title", () => {
		const r = parseMarkdown("# ZK Commiti\n\nBody", "a.md", GENERIC_PROFILE);
		expect(r.frontmatter.title).toBeNull();
		expect(r.title).toBe("ZK Commiti");
	});

	it("prefers the frontmatter title over the first heading", () => {
		const r = parseMarkdown("---\ntitle: FM\n---\n\n# H1", "a.md", GENERIC_PROFILE);
		expect(r.title).toBe("FM");
	});

	it("is null with neither frontmatter nor headings", () => {
		const r = parseMarkdown("plain body only", "a.md", GENERIC_PROFILE);
		expect(r.title).toBeNull();
	});
});

describe("parseMarkdown — heading nesting", () => {
	it("links parents by depth", () => {
		const r = parseMarkdown("# A\n## B\n### C\n## D", "t.md", GENERIC_PROFILE);
		expect(r.headings).toHaveLength(4);
		expect(r.headings[0]!.parentIndex).toBeNull();
		expect(r.headings[1]!.parentIndex).toBe(0);
		expect(r.headings[2]!.parentIndex).toBe(1);
		expect(r.headings[3]!.parentIndex).toBe(0);
	});

	it("ignores headings inside code fences", () => {
		const content = "# Real\n```python\n# fake\n```\n## Also real";
		const r = parseMarkdown(content, "t.md", GENERIC_PROFILE);
		expect(r.headings).toHaveLength(2);
		expect(r.headings[0]!.text).toBe("Real");
		expect(r.headings[1]!.text).toBe("Also real");
	});
});

describe("parseMarkdown — bracket-ID scanning", () => {
	it("scans sub-ids like RQ2.1", () => {
		const r = parseMarkdown("Text [RQ2.1] and [C4].", "t.md", ZKSRC_PROFILE);
		expect(r.entityRefs).toContain("RQ2.1");
		expect(r.entityRefs).toContain("C4");
	});

	it("ignores non-namespace brackets like [INFERENCE]", () => {
		const r = parseMarkdown("[INFERENCE] and [NOTE]", "t.md", ZKSRC_PROFILE);
		expect(r.entityRefs).not.toContain("INFERENCE");
	});

	it("does not scan inline refs for generic profile", () => {
		const r = parseMarkdown("Text [C4] here.", "t.md", GENERIC_PROFILE);
		expect(r.entityRefs).not.toContain("C4");
	});

	it("creates mentions edges for inline refs", () => {
		const r = parseMarkdown("See [C4] and [SP7].", "t.md", ZKSRC_PROFILE);
		const mentions = r.relations.filter(rel => rel.type === "mentions");
		expect(mentions.map(m => m.dstEntity).toSorted()).toEqual(["C4", "SP7"]);
		expect(mentions.every(m => m.origin === "inline")).toBe(true);
	});
});

describe("parseMarkdown — relations", () => {
	it("extracts frontmatter relations as typed edges", () => {
		const content = "---\nrelations:\n  - \"[SP7] gates [C13]\"\n  - \"[C13] derived-from [C4]\"\n---\n\nBody";
		const r = parseMarkdown(content, "t.md", ZKSRC_PROFILE);
		expect(r.relations).toHaveLength(2);
		expect(r.relations[0]!.srcEntity).toBe("SP7");
		expect(r.relations[0]!.dstEntity).toBe("C13");
		expect(r.relations[0]!.type).toBe("gates");
		expect(r.relations[1]!.type).toBe("derived-from");
	});

	it("skips malformed relation strings", () => {
		const content = "---\nrelations:\n  - \"not a relation\"\n  - \"[A] gates [B]\"\n---\n\nBody";
		const r = parseMarkdown(content, "t.md", ZKSRC_PROFILE);
		expect(r.relations).toHaveLength(1);
		expect(r.relations[0]!.srcEntity).toBe("A");
	});
});

describe("parseMarkdown — definition sites", () => {
	it("detects heading-based definition sites", () => {
		const r = parseMarkdown("# C4: Trust Verification\n\nBody", "t.md", ZKSRC_PROFILE);
		const sites = r.definitionSites.filter(s => s.name === "C4");
		expect(sites.length).toBeGreaterThanOrEqual(1);
		expect(sites[0]!.kind).toBe("heading");
	});

	it("detects table first-cell definition sites", () => {
		const r = parseMarkdown("| C4 | description |\n|---|---|\n| other | x |", "t.md", ZKSRC_PROFILE);
		const sites = r.definitionSites.filter(s => s.name === "C4");
		expect(sites.length).toBeGreaterThanOrEqual(1);
	});

	it("detects bold definition sites", () => {
		const r = parseMarkdown("Text **C4** here.", "t.md", ZKSRC_PROFILE);
		const sites = r.definitionSites.filter(s => s.name === "C4");
		expect(sites.length).toBeGreaterThanOrEqual(1);
		expect(sites.some(s => s.kind === "bold")).toBe(true);
	});

	it("adds frontmatter entities as definition sites", () => {
		const r = parseMarkdown("---\nentities: [claim]\n---\n\nBody", "t.md", GENERIC_PROFILE);
		const sites = r.definitionSites.filter(s => s.name === "claim");
		expect(sites.length).toBe(1);
		expect(sites[0]!.kind).toBe("frontmatter");
	});
});
