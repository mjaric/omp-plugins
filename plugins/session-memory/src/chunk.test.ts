import { describe, expect, it } from "bun:test";
import { chunkMessage, estimateTokens, extractMessageText, splitBySize } from "./chunk";

describe("estimateTokens", () => {
	it("estimates ~4 chars per token with a floor of 1", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("a".repeat(4000))).toBe(1000);
		expect(estimateTokens("")).toBe(1);
	});
});

describe("extractMessageText", () => {
	it("accepts user and assistant messages with string content", () => {
		expect(extractMessageText({ role: "user", content: "hello world" })).toEqual({
			role: "user",
			text: "hello world",
		});
		expect(extractMessageText({ role: "assistant", content: "reply text" })?.role).toBe("assistant");
	});

	it("flattens text blocks and drops non-text blocks", () => {
		const message = {
			role: "user",
			content: [
				{ type: "text", text: "first" },
				{ type: "image", source: "x" },
				{ type: "text", text: "second" },
			],
		};
		expect(extractMessageText(message)?.text).toBe("first\nsecond");
	});

	it("rejects tool/system roles", () => {
		expect(extractMessageText({ role: "toolResult", content: "data here" })).toBeNull();
		expect(extractMessageText({ role: "system", content: "rules here" })).toBeNull();
	});

	it("rejects empty, whitespace-only, and symbol-only noise", () => {
		expect(extractMessageText({ role: "user", content: "" })).toBeNull();
		expect(extractMessageText({ role: "user", content: "   \n\t " })).toBeNull();
		expect(extractMessageText({ role: "user", content: "!!! --- ???" })).toBeNull();
		expect(extractMessageText({ role: "user", content: "a" })).toBeNull();
	});

	it("rejects non-object input", () => {
		expect(extractMessageText(null)).toBeNull();
		expect(extractMessageText("plain string")).toBeNull();
	});
});

describe("chunkMessage", () => {
	it("keeps a short message as a single chunk", () => {
		const input = { sessionId: "s1", role: "user" as const, turnNo: 1, text: "short text", tokenEstimate: 3 };
		const chunks = chunkMessage(input, 1200);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.text).toBe("short text");
		expect(chunks[0]?.sessionId).toBe("s1");
	});

	it("splits an oversized message into multiple chunks under the cap", () => {
		const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} carries content.`);
		const input = {
			sessionId: "s1",
			role: "assistant" as const,
			turnNo: 2,
			text: sentences.join(" "),
			tokenEstimate: 200,
		};
		const chunks = chunkMessage(input, 20);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.tokenEstimate).toBeLessThanOrEqual(25);
		}
		expect(chunks.every(c => c.text.trim().length > 0)).toBe(true);
	});

	it("hard-splits a single sentence longer than the cap", () => {
		const text = "x".repeat(400);
		const pieces = splitBySize(text, 20);
		expect(pieces.length).toBeGreaterThan(1);
		for (const piece of pieces) {
			expect(piece.length).toBeLessThanOrEqual(80);
		}
	});
});
