import { describe, expect, it } from "bun:test";
import { parseAcceptance, parseBodyBlockers } from "./issue";

describe("parseAcceptance", () => {
	it("returns complete when all boxes checked", () => {
		const body = `
## Scope
Do the thing.

## Acceptance
- [x] REQ-001: verified by \`test_foo\`
- [x] REQ-002: verified by \`test_bar\`
- [x] Gate: cargo test, clippy
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("returns incomplete with missing items", () => {
		const body = `
## Acceptance
- [x] REQ-001: verified by \`test_foo\`
- [ ] REQ-002: verified by \`test_bar\`
- [x] Gate: cargo test
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(false);
		expect(result.missing).toEqual(["REQ-002: verified by `test_bar`"]);
	});

	it("returns incomplete when no acceptance section exists", () => {
		const body = `
## Scope
Some scope.

## Dependencies
None.
`;
		const result = parseAcceptance(body);
		expect(result.complete).toBe(false);
		expect(result.missing).toEqual(["no Acceptance section found"]);
	});

	it("stops at next heading", () => {
		const body = `
## Acceptance
- [x] REQ-001
- [ ] REQ-002

## Dependencies
- [ ] This should not be counted
`;
		const result = parseAcceptance(body);
		expect(result.missing).toEqual(["REQ-002"]);
	});
});

describe("parseBodyBlockers", () => {
	it("extracts single blocker", () => {
		const blockers = parseBodyBlockers("Blocked by #12\n");
		expect(blockers).toEqual([12]);
	});

	it("extracts multiple blockers from comma list", () => {
		const blockers = parseBodyBlockers("Blocked by #12, #13, #14\n");
		expect(blockers).toEqual([12, 13, 14]);
	});

	it("matches case-insensitively and with hyphen", () => {
		const blockers1 = parseBodyBlockers("blocked by #5");
		const blockers2 = parseBodyBlockers("blocked-by #5");
		const blockers3 = parseBodyBlockers("Depends on #5");
		expect(blockers1).toEqual([5]);
		expect(blockers2).toEqual([5]);
		expect(blockers3).toEqual([5]);
	});

	it("returns empty when no blocker text", () => {
		const blockers = parseBodyBlockers("No dependencies.\n");
		expect(blockers).toEqual([]);
	});
});
