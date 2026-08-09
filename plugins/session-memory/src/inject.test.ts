import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	LEDGER_TYPE,
	applyContextInjection,
	buildInjectionMessage,
	contextHashes,
	createInjectState,
	formatRecallMessage,
	pendingInjectedIds,
	rebuildLedger,
} from "./inject";
import type { InjectState } from "./inject";
import type { RecallPackage } from "./types";
import { textHash } from "./workspace";

function pkg(overrides: Partial<RecallPackage> = {}): RecallPackage {
	return {
		mode: "prefix-safe",
		references: [{ turnNo: 2, role: "user" }],
		chunks: [{ id: 11, turnNo: 5, role: "assistant", text: "new material", score: 0.9 }],
		injectedChunks: 1,
		injectedChars: 12,
		dedupedChunks: 1,
		recallMs: 3,
		...overrides,
	};
}

function state(pending: RecallPackage | null): InjectState {
	const s = createInjectState();
	s.pending = pending;
	return s;
}

describe("rebuildLedger", () => {
	it("collects ids from matching ledger entries only", () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "custom", customType: LEDGER_TYPE, data: { ids: [1, 2, 3.5] } },
			{ type: "custom", customType: "com.other.type", data: { ids: [9] } },
			{ type: "custom", customType: LEDGER_TYPE, data: { ids: [4, "bad"] } },
			{ type: "custom", customType: LEDGER_TYPE, data: null },
		] as unknown as SessionEntry[];
		expect([...rebuildLedger(branch)].toSorted((a, b) => a - b)).toEqual([1, 2, 3.5, 4]);
	});

	it("returns an empty set without ledger entries", () => {
		expect(rebuildLedger([])).toEqual(new Set());
	});
});

describe("contextHashes", () => {
	it("hashes the text of indexable messages only", () => {
		const messages = [
			{ role: "user", content: "hello world" },
			{ role: "assistant", content: "reply text" },
			{ role: "toolResult", content: "noise here" },
			{ role: "user", content: "!!" },
		];
		const hashes = contextHashes(messages);
		expect(hashes.size).toBe(2);
		expect(hashes.has(textHash("hello world"))).toBe(true);
		expect(hashes.has(textHash("reply text"))).toBe(true);
	});
});

describe("applyContextInjection — prefix safety (spec §7.5)", () => {
	it("returns the prefix byte-identical with exactly one appended message", () => {
		const prefix = [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }];
		const before = JSON.stringify(prefix);
		const result = applyContextInjection(prefix, state(pkg()));
		expect(result).toBeDefined();
		expect(result!.length).toBe(prefix.length + 1);
		expect(JSON.stringify(result!.slice(0, prefix.length))).toBe(before);
		const appended = result![result!.length - 1] as { role: string; content: string };
		expect(appended.role).toBe("user");
		expect(appended.content).toContain("new material");
	});

	it("appends nothing without a pending package", () => {
		expect(applyContextInjection([{ role: "user", content: "q" }], state(null))).toBeUndefined();
	});

	it("appends nothing in off mode or with zero fresh chunks", () => {
		expect(applyContextInjection([], state(pkg({ mode: "off" })))).toBeUndefined();
		expect(applyContextInjection([], state(pkg({ chunks: [] })))).toBeUndefined();
	});

	it("sets injectedThisTurn exactly once per pending package", () => {
		const s = state(pkg());
		expect(s.injectedThisTurn).toBe(false);
		applyContextInjection([], s);
		expect(s.injectedThisTurn).toBe(true);
	});
});

describe("formatRecallMessage", () => {
	it("renders chunks with attribution and a references footer", () => {
		const text = formatRecallMessage(pkg());
		expect(text).toContain("[turn 5, assistant]");
		expect(text).toContain("new material");
		expect(text).toContain("Already covered (not repeated): [turn 2, user]");
	});

	it("omits the references footer when nothing is present", () => {
		const text = formatRecallMessage(pkg({ references: [] }));
		expect(text).not.toContain("Already covered");
	});
});

describe("buildInjectionMessage / pendingInjectedIds", () => {
	it("builds a user-role message with the formatted package", () => {
		const msg = buildInjectionMessage(pkg());
		expect(msg.role).toBe("user");
		expect(msg.content).toContain("new material");
		expect(typeof msg.timestamp).toBe("number");
	});

	it("lists pending chunk ids and handles a null pending package", () => {
		expect(pendingInjectedIds(state(pkg()))).toEqual([11]);
		expect(pendingInjectedIds(state(null))).toEqual([]);
	});
});
