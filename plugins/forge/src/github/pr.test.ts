import { describe, expect, it } from "bun:test";
import { buildReviewContract, formatReviewContract } from "./pr";

describe("buildReviewContract", () => {
	it("extracts sections by heading", () => {
		const body = `
## Scope
Create the thing.

## Spec references
- REQ-001

## Acceptance
- [ ] REQ-001: verified by \`test_thing\`
`;
		const contract = buildReviewContract(42, body);
		expect(contract.issueNumber).toBe(42);
		expect(contract.scope).toContain("Create the thing");
		expect(contract.specReferences).toContain("REQ-001");
		expect(contract.acceptance).toContain("test_thing");
	});

	it("handles missing sections gracefully", () => {
		const body = "Just some text, no sections.";
		const contract = buildReviewContract(1, body);
		expect(contract.scope).toBe("(no scope section)");
		expect(contract.specReferences).toBe("(no spec references)");
		expect(contract.acceptance).toBe("(no acceptance section)");
	});
});

describe("formatReviewContract", () => {
	it("produces a formatted string with all sections", () => {
		const contract = {
			issueNumber: 7,
			scope: "Do X.",
			specReferences: "REQ-007",
			acceptance: "- [ ] REQ-007: test",
		};
		const formatted = formatReviewContract(contract);
		expect(formatted).toContain("Issue #7");
		expect(formatted).toContain("### Scope");
		expect(formatted).toContain("Do X.");
		expect(formatted).toContain("### Acceptance criteria");
		expect(formatted).toContain("REQ-007: test");
	});
});
