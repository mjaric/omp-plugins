import { describe, expect, it } from "bun:test";
import {
	SELECTION_ENTRY_TYPE,
	clearSelection,
	createLedger,
	isPending,
	persistSelection,
	rebuildSelection,
	type LedgerEntry,
} from "./selection";

/** A recording sink that captures every appendEntry call (matches ExtensionAPI slice). */
function recordingSink(): { sink: { appendEntry: (t: string, d?: unknown) => void }; calls: { type: string; data?: unknown }[] } {
	const calls: { type: string; data?: unknown }[] = [];
	return {
		sink: { appendEntry: (type, data) => calls.push({ type, data }) },
		calls,
	};
}

function bundle(content = "## a.md\nexcerpt", sources = ["a.md"]) {
	return { content, sources, prompt: "p", createdAt: 100 };
}

function customEntry(customType: string, data?: unknown): LedgerEntry {
	return { type: "custom", customType, data };
}

describe("ledger round-trip", () => {
	it("persistSelection stores the bundle in memory and appends a durable entry", () => {
		const { sink, calls } = recordingSink();
		const ledger = createLedger();
		expect(isPending(ledger.bundle)).toBe(false);

		persistSelection(sink, ledger, bundle());
		expect(isPending(ledger.bundle)).toBe(true);
		expect(ledger.bundle?.sources).toEqual(["a.md"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.type).toBe(SELECTION_ENTRY_TYPE);
		expect(calls[0]?.data).toEqual(bundle());
	});

	it("clearSelection removes the in-memory bundle and writes a tombstone only when pending", () => {
		const { sink, calls } = recordingSink();
		const ledger = createLedger();

		clearSelection(sink, ledger);
		expect(calls).toHaveLength(0); // nothing pending → no tombstone

		persistSelection(sink, ledger, bundle());
		calls.length = 0;
		clearSelection(sink, ledger);
		expect(ledger.bundle).toBeNull();
		expect(calls).toHaveLength(1);
		expect((calls[0]?.data as { content: string } | undefined)?.content).toBe(""); // tombstone
	});
});

describe("rebuildSelection", () => {
	it("returns the last selection entry on the branch", () => {
		const entries = [
			customEntry(SELECTION_ENTRY_TYPE, bundle("first")),
			customEntry(SELECTION_ENTRY_TYPE, bundle("second")),
		];
		expect(rebuildSelection(entries)?.content).toBe("second");
	});

	it("ignores entries with other customTypes", () => {
		const entries = [
			customEntry("com.mjaric.file-graph.state", { foo: 1 }),
			customEntry(SELECTION_ENTRY_TYPE, bundle("real")),
		];
		expect(rebuildSelection(entries)?.content).toBe("real");
	});

	it("yields null when the last entry is a tombstone (clear)", () => {
		const entries = [
			customEntry(SELECTION_ENTRY_TYPE, bundle("real")),
			customEntry(SELECTION_ENTRY_TYPE, bundle("")),
		];
		expect(rebuildSelection(entries)).toBeNull();
	});

	it("yields null when no selection entries exist", () => {
		expect(rebuildSelection([customEntry("other.type", bundle("x"))])).toBeNull();
		expect(rebuildSelection([])).toBeNull();
	});

	it("skips malformed entry data", () => {
		const entries = [
			customEntry(SELECTION_ENTRY_TYPE, "not-an-object"),
			customEntry(SELECTION_ENTRY_TYPE, bundle("good")),
		];
		expect(rebuildSelection(entries)?.content).toBe("good");
	});

	it("rebuilds sources even when the persisted data omits optional fields", () => {
		const entries = [customEntry(SELECTION_ENTRY_TYPE, { content: "c", prompt: 123 })];
		const result = rebuildSelection(entries);
		expect(result?.content).toBe("c");
		expect(result?.sources).toEqual([]);
	});
});

describe("rebuild + clear consistency", () => {
	it("a persisted-then-cleared ledger rebuilds as pending=null", () => {
		const { sink } = recordingSink();
		const ledger = createLedger();
		persistSelection(sink, ledger, bundle("payload"));
		clearSelection(sink, ledger);
		// Simulate the recorded entries being the branch.
		const entries: LedgerEntry[] = [
			customEntry(SELECTION_ENTRY_TYPE, bundle("payload")),
			customEntry(SELECTION_ENTRY_TYPE, { content: "", sources: [], prompt: "", createdAt: 0 }),
		];
		ledger.bundle = rebuildSelection(entries);
		expect(ledger.bundle).toBeNull();
	});
});
