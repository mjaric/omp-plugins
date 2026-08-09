import { describe, expect, it } from "bun:test";
import {
	candidateFingerprint,
	filterInContext,
	fingerprint,
	messageFingerprints,
	toCandidates,
	type SuggestionCandidate,
} from "./candidates";
import type { SearchHit } from "../types";

function candidate(over: Partial<SuggestionCandidate>): SuggestionCandidate {
	return {
		path: "claims.md",
		title: "Claims Registry",
		purpose: "Source of truth.",
		anchors: [{ kind: "heading", text: "C4 Trust" }],
		score: 1,
		...over,
	};
}

function hit(path: string, title: string | null): SearchHit {
	return {
		fileId: 1,
		path,
		title,
		purpose: null,
		score: 1,
		anchors: [],
		relations: [],
	};
}

describe("toCandidates", () => {
	it("projects search hits into candidates", () => {
		const candidates = toCandidates([hit("a.md", "Alpha"), hit("b.md", null)]);
		expect(candidates.map(c => c.path)).toEqual(["a.md", "b.md"]);
		expect(candidates[0]!.title).toBe("Alpha");
	});

	it("decouples anchors into the candidate view", () => {
		const [c] = toCandidates([
			{ ...hit("a.md", null), anchors: [{ kind: "heading", text: "X", line: 3 }] },
		]);
		expect(c!.anchors).toEqual([{ kind: "heading", text: "X" }]);
	});
});

describe("filterInContext", () => {
	it("removes candidates whose path is already referenced in the session", () => {
		const a = candidate({ path: "a.md" });
		const b = candidate({ path: "b.md" });
		const kept = filterInContext([a, b], {
			inContextPaths: new Set(["a.md"]),
			contentFingerprints: new Set(),
		});
		expect(kept.map(c => c.path)).toEqual(["b.md"]);
	});

	it("removes candidates whose identity is already quoted in messages", () => {
		const quoted = candidate({ path: "c.md", title: "Claims", anchors: [{ kind: "heading", text: "C4" }] });
		const fresh = candidate({ path: "d.md", title: "Spikes", anchors: [] });
		const fingerprints = new Set([candidateFingerprint(quoted)]);
		const kept = filterInContext([quoted, fresh], {
			inContextPaths: new Set(),
			contentFingerprints: fingerprints,
		});
		expect(kept.map(c => c.path)).toEqual(["d.md"]);
	});

	it("keeps everything when nothing is in context", () => {
		const a = candidate({ path: "a.md" });
		const kept = filterInContext([a], { inContextPaths: new Set(), contentFingerprints: new Set() });
		expect(kept).toHaveLength(1);
	});

	it("treats path membership and content match independently", () => {
		const a = candidate({ path: "a.md", title: "Same", anchors: [{ kind: "entity", text: "Z" }] });
		const fingerprints = new Set([candidateFingerprint(a)]);
		// Same identity but a DIFFERENT path: still dropped by the fingerprint match.
		const sameIdentityOtherPath = candidate({ path: "other.md", title: "Same", anchors: [{ kind: "entity", text: "Z" }] });
		const kept = filterInContext([sameIdentityOtherPath], {
			inContextPaths: new Set(),
			contentFingerprints: fingerprints,
		});
		expect(kept).toHaveLength(0);
	});
});

describe("fingerprint", () => {
	it("is stable for identical normalised content", () => {
		expect(fingerprint("Claims C4")).toBe(fingerprint("  claims  c4 "));
	});

	it("ignores incidental whitespace and case differences", () => {
		expect(fingerprint("Alpha\nBeta")).toBe(fingerprint("alpha beta"));
	});

	it("messageFingerprints skips empty texts", () => {
		const set = messageFingerprints(["", "x", " "]);
		expect(set.size).toBe(1);
	});
});
