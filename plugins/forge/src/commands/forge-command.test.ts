import { describe, expect, it, beforeEach } from "bun:test";
import { parseArgs, USAGE } from "./forge-command";
import { renderBoard, type BoardRenderer } from "./board-render";
import type { BoardState } from "../github/board";

describe("parseArgs", () => {
	it("parses subcommand with no args", () => {
		expect(parseArgs("board")).toEqual({ sub: "board", args: [] });
	});

	it("parses subcommand with args", () => {
		expect(parseArgs("board ready")).toEqual({ sub: "board", args: ["ready"] });
	});

	it("handles empty string", () => {
		expect(parseArgs("")).toEqual({ sub: "", args: [] });
	});

	it("handles extra whitespace", () => {
		expect(parseArgs("  dispatch   42  ")).toEqual({ sub: "dispatch", args: ["42"] });
	});

	it("USAGE is a non-empty string", () => {
		expect(USAGE.length).toBeGreaterThan(0);
		expect(USAGE).toContain("forge");
	});
});

describe("renderBoard", () => {
	// Capture renderer output
	const messages: Array<{ msg: string; type: string }> = [];
	const testRenderer: BoardRenderer = {
		notify: (msg, type = "info") => messages.push({ msg, type }),
		hasUI: true,
	};

	const sampleState: BoardState = {
		items: [
			{ issueNumber: 3, title: "smith-core domain types", state: "OPEN", status: "Backlog", slice: "Slice 1", milestone: "Slice 1 — Model core" },
			{ issueNumber: 1, title: "Smoke test", state: "CLOSED", status: "Done", slice: "Slice 0", milestone: null },
			{ issueNumber: 4, title: "smith-store SQLite schema", state: "OPEN", status: "Backlog", slice: "Slice 1", milestone: "Slice 1 — Model core" },
		],
	};

	beforeEach(() => {
		messages.length = 0;
	});

	it("groups items by status in canonical order", () => {
		renderBoard(sampleState, undefined, testRenderer);
		const output = messages.map((m) => m.msg).join("\n");

		// Backlog should appear before Done
		const backlogIdx = output.indexOf("[Backlog]");
		const doneIdx = output.indexOf("[Done]");
		expect(backlogIdx).toBeGreaterThan(-1);
		expect(doneIdx).toBeGreaterThan(-1);
		expect(backlogIdx).toBeLessThan(doneIdx);
	});

	it("shows issue numbers and titles", () => {
		renderBoard(sampleState, undefined, testRenderer);
		const output = messages.map((m) => m.msg).join("\n");
		expect(output).toContain("#3");
		expect(output).toContain("#4");
		expect(output).toContain("smith-core domain types");
	});

	it("filters to a single status", () => {
		renderBoard(sampleState, "done", testRenderer);
		const output = messages.map((m) => m.msg).join("\n");
		expect(output).toContain("[Done]");
		expect(output).not.toContain("[Backlog]");
	});

	it("filters by slice", () => {
		renderBoard(sampleState, "slice-0", testRenderer);
		const output = messages.map((m) => m.msg).join("\n");
		expect(output).toContain("#1");
		expect(output).not.toContain("#3");
	});

	it("shows 'no items match' for empty filter result", () => {
		renderBoard({ items: [] }, undefined, testRenderer);
		const output = messages.map((m) => m.msg).join("\n");
		expect(output).toContain("no items match");
	});
});
