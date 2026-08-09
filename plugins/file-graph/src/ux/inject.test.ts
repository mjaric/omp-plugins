import { describe, expect, it } from "bun:test";
import { applyInjection, INJECT_CUSTOM_TYPE, renderInjectionContent } from "./inject";
import type { SelectionBundle } from "./selection";

/** The message-array type applyInjection consumes (ContextEvent["messages"]). */
type Messages = Parameters<typeof applyInjection>[0];

function sampleMessages(): Messages {
	return [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: [{ type: "text", text: "hi" }] },
	] as Messages;
}

function bundle(over: Partial<SelectionBundle> = {}): SelectionBundle {
	return { content: "## a.md\ntrust excerpt", sources: ["a.md"], prompt: "p", createdAt: 1, ...over };
}

describe("applyInjection — append-only property", () => {
	it("appends exactly one message when a selection is pending", () => {
		const msgs = sampleMessages();
		const result = applyInjection(msgs, bundle());
		expect(result).toBeDefined();
		expect(result?.messages).toHaveLength(msgs.length + 1);
	});

	it("keeps the prefix byte-identical (same element references, original untouched)", () => {
		const msgs = sampleMessages();
		const n = msgs.length;
		const out = applyInjection(msgs, bundle())!.messages!;
		for (let i = 0; i < n; i++) {
			expect(out[i]).toBe(msgs[i]); // identical reference, never reordered or cloned
		}
		expect(msgs).toHaveLength(n); // input array not mutated
	});

	it("does not append without a pending selection", () => {
		const msgs = sampleMessages();
		expect(applyInjection(msgs, null)).toBeUndefined();
	});

	it("does not append for a tombstone (empty-content) bundle", () => {
		const msgs = sampleMessages();
		expect(applyInjection(msgs, bundle({ content: "" }))).toBeUndefined();
	});

	it("appends a reference-material message with the injected customType", () => {
		const msgs = sampleMessages();
		const out = applyInjection(msgs, bundle())!.messages!;
		const appended = out[out.length - 1] as { customType: string; content: string };
		expect(appended.customType).toBe(INJECT_CUSTOM_TYPE);
		expect(appended.content).toContain("a.md");
	});
});

describe("renderInjectionContent", () => {
	it("frames the bundle as reference material, not instructions", () => {
		const text = renderInjectionContent(bundle({ content: "## a.md\nbody" }));
		expect(text).toContain("NOT instructions");
		expect(text).toContain("## a.md\nbody");
	});

	it("does not mutate the bundle content", () => {
		const b = bundle({ content: "raw" });
		renderInjectionContent(b);
		expect(b.content).toBe("raw");
	});
});
