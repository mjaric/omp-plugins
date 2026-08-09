import { describe, expect, it } from "bun:test";
import type { ExtensionContext, InputEvent } from "@oh-my-pi/pi-coding-agent";
import { createRuntime } from "../tools/shared";
import { createLedger } from "./selection";
import {
	buildWidgetLines,
	clipExcerpt,
	createInputHandler,
	createSelectionShortcut,
	extractSources,
	fallbackExcerpt,
	makeBundle,
	renderPrefill,
	SELECTION_SHORTCUT,
} from "./flow";
import type { SuggestionCandidate } from "./candidates";

/** Minimal ctx for the headless-guard paths (only the fields those paths touch). */
function fakeCtx(over: { hasUI?: boolean; editorText?: string } = {}): ExtensionContext {
	const calls: { widget?: unknown; notify?: string } = {};
	const ctx = {
		hasUI: over.hasUI ?? false,
		cwd: "/tmp/fg-test",
		ui: {
			notify: (message: string) => {
				calls.notify = message;
			},
			setWidget: (_key: string, content: unknown) => {
				calls.widget = content;
			},
			getEditorText: () => over.editorText ?? "",
		},
		sessionManager: { getBranch: () => [] },
		callLog: calls,
	};
	return ctx as unknown as ExtensionContext;
}

function candidate(over: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
	return {
		path: "claims.md",
		title: "Claims",
		purpose: "trust source",
		anchors: [{ kind: "heading", text: "C4" }],
		score: 2,
		...over,
	};
}

describe("input handler — headless guard", () => {
	it("is a no-op (no widget) when hasUI is false", async () => {
		const handler = createInputHandler(createRuntime());
		const ctx = fakeCtx({ hasUI: false });
		const event = { type: "input", text: "trust", source: "interactive" } as InputEvent;
		await handler(event, ctx);
		expect((ctx as unknown as { callLog: { widget?: unknown } }).callLog.widget).toBeUndefined();
	});
});

describe("shortcut handler — headless guard", () => {
	it("notifies and never persists when hasUI is false", async () => {
		const sink = { appendEntry: () => { throw new Error("must not persist when headless"); } };
		const ledger = createLedger();
		const handler = createSelectionShortcut(sink, createRuntime(), ledger);
		const ctx = fakeCtx({ hasUI: false });
		await handler(ctx);
		const calls = (ctx as unknown as { callLog: { notify?: string } }).callLog;
		expect(calls.notify).toContain("alt+g");
		expect(ledger.bundle).toBeNull();
	});

	it("asks for a prompt first when the editor is empty", async () => {
		const ledger = createLedger();
		const sink = { appendEntry: () => { throw new Error("must not persist without prompt"); } };
		const handler = createSelectionShortcut(sink, createRuntime(), ledger);
		const ctx = fakeCtx({ hasUI: true, editorText: "   " });
		await handler(ctx);
		const calls = (ctx as unknown as { callLog: { notify?: string } }).callLog;
		expect(calls.notify).toContain("prompt");
		expect(ledger.bundle).toBeNull();
	});
});

describe("buildWidgetLines", () => {
	it("returns undefined when there are no candidates (clears the widget)", () => {
		expect(buildWidgetLines([])).toBeUndefined();
	});

	it("lists candidates with an alt+g hint", () => {
		const lines = buildWidgetLines([candidate(), candidate({ path: "spikes.md" })]);
		expect(lines?.[0]).toContain("file-graph");
		expect(lines?.some(l => l.includes("claims.md"))).toBe(true);
		expect(lines?.some(l => l.includes(SELECTION_SHORTCUT))).toBe(true);
	});
});

describe("renderPrefill + extractSources round-trip", () => {
	it("emits a ## path header per candidate", () => {
		const text = renderPrefill(
			[candidate({ path: "a.md" }), candidate({ path: "b.md", purpose: null, title: "B" })],
			new Map([["a.md", "excerpt-a"], ["b.md", "excerpt-b"]]),
		);
		expect(text).toContain("## a.md");
		expect(text).toContain("excerpt-a");
		expect(text).toContain("## b.md");
	});

	it("extractSources recovers paths from an edited package", () => {
		const edited = "## a.md\nbody-a\n\n## b.md\nbody-b";
		expect(extractSources(edited)).toEqual(["a.md", "b.md"]);
	});

	it("makeBundle pairs content with recovered sources", () => {
		const bundle = makeBundle("prompt", "## c.md\nx");
		expect(bundle.content).toBe("## c.md\nx");
		expect(bundle.sources).toEqual(["c.md"]);
		expect(bundle.prompt).toBe("prompt");
	});
});

describe("excerpt helpers", () => {
	it("clipExcerpt windows around a start line", () => {
		expect(clipExcerpt("a\nb\nc\nd", 1, 2)).toBe("b\nc");
	});

	it("clipExcerpt clamps a start beyond the content", () => {
		expect(clipExcerpt("a\nb", 10, 3)).toBe("b");
	});

	it("fallbackExcerpt joins anchor texts", () => {
		expect(fallbackExcerpt(candidate({ anchors: [{ kind: "heading", text: "X" }, { kind: "entity", text: "Y" }] }))).toBe("X · Y");
	});

	it("fallbackExcerpt falls back to purpose when no anchors", () => {
		expect(fallbackExcerpt(candidate({ anchors: [], purpose: "p" }))).toBe("p");
	});
});
