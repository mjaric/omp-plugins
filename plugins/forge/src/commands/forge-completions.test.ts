import { describe, expect, it } from "bun:test";
import { getForgeArgumentCompletions } from "./forge-completions";

/** Labels of the returned items, or null. */
function labels(prefix: string): string[] | null {
	const items = getForgeArgumentCompletions(prefix);
	return items === null ? null : items.map((item) => item.label);
}

describe("getForgeArgumentCompletions — subcommands", () => {
	it("lists every subcommand for an empty argument", () => {
		const items = getForgeArgumentCompletions("");
		expect(items).not.toBeNull();
		const names = items!.map((item) => item.value);
		for (const expected of ["setup", "board", "dispatch", "review", "decide", "round", "promote", "status", "decompose", "thinking-report", "retrospect", "doctor"]) {
			expect(names).toContain(expected);
		}
	});

	it("filters by prefix", () => {
		expect(labels("di")).toEqual(["dispatch"]);
		expect(labels("doc")).toEqual(["doctor"]);
	});

	it("returns null when no subcommand matches", () => {
		expect(labels("zzz")).toBeNull();
	});

	it("carries a usage hint for subcommands with args", () => {
		const items = getForgeArgumentCompletions("dis")!;
		const dispatch = items.find((item) => item.label === "dispatch");
		expect(dispatch?.hint).toBe("<issue>");
	});
});

describe("getForgeArgumentCompletions — per-subcommand extras", () => {
	it("suggests board status filters after a space", () => {
		expect(labels("board ")).toEqual(["backlog", "ready", "in_progress", "in_review", "done"]);
	});

	it("filters board filters by typed prefix", () => {
		expect(labels("board r")).toEqual(["ready"]);
	});

	it("suggests flags for dispatch and round", () => {
		expect(labels("dispatch ")).toEqual(["--project"]);
		expect(labels("round --p")).toEqual(["--project"]);
	});

	it("suggests --milestone for retrospect", () => {
		expect(labels("retrospect --")).toEqual(["--milestone"]);
	});

	it("returns null for subcommands without extras", () => {
		expect(labels("status ")).toBeNull();
		expect(labels("promote x")).toBeNull();
	});

	it("returns null for unknown subcommands", () => {
		expect(labels("bogus ")).toBeNull();
	});

	it("stops suggesting extras once another token starts", () => {
		expect(labels("board ready ")).toBeNull();
	});

	it("keeps a trailing space in flag values so the cursor advances past the flag", () => {
		const items = getForgeArgumentCompletions("dispatch ")!;
		expect(items[0]?.value).toBe("dispatch --project ");
	});

	it("re-embeds the subcommand so accepting an item does not wipe it (round bug)", () => {
		// omp TUI contract: accepting a completion replaces the ENTIRE text after
		// `/forge ` with item.value (CombinedAutocompleteProvider.applyCompletion).
		// Reproduce that acceptance for `/forge round --p` + Tab.
		const argumentText = "round --p";
		const items = getForgeArgumentCompletions(argumentText)!;
		const line = `/forge ${argumentText}`;
		const beforePrefix = line.slice(0, line.length - argumentText.length);
		expect(beforePrefix + items[0]!.value).toBe("/forge round --project ");
	});

	it("re-embeds the subcommand for board filter values", () => {
		const items = getForgeArgumentCompletions("board r")!;
		expect(items[0]?.value).toBe("board ready");
	});
});
