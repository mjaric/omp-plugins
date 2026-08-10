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
		for (const expected of ["setup", "board", "plan", "dispatch", "review", "decide", "round", "promote", "status", "decompose", "guide", "thinking-report", "retrospect", "doctor"]) {
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

	it("returns null for dispatch (no flags — project resolved from git remote)", () => {
		expect(labels("dispatch ")).toBeNull();
	});

	it("returns null for round (no flags — project resolved from git remote)", () => {
		expect(labels("round ")).toBeNull();
	});

	it("re-embeds the subcommand for board filter values", () => {
		const items = getForgeArgumentCompletions("board r")!;
		expect(items[0]?.value).toBe("board ready");
	});
});
