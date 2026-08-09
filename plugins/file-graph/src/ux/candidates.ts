/**
 * Candidate computation for the UX flow (spec §8) — pure logic only.
 *
 * Given the raw `suggest()` hits plus a view of what is already in context
 * (files referenced this session + fingerprints of the current messages),
 * return the candidates that are relevant but NOT already present.
 *
 * Everything here is side-effect free so the filtering contract is fully
 * testable without a store, network, or omp runtime.
 */

import type { SearchHit } from "../types";

/** A suggestion projected from a `SearchHit`, decoupled from the store. */
export interface SuggestionCandidate {
	path: string;
	title: string | null;
	purpose: string | null;
	anchors: ReadonlyArray<{ kind: string; text: string }>;
	score: number;
}

/** Project search hits into the candidate view the UX flow consumes. */
export function toCandidates(hits: readonly SearchHit[]): SuggestionCandidate[] {
	return hits.map(toCandidate);
}

/** Project one hit into a candidate. */
function toCandidate(hit: SearchHit): SuggestionCandidate {
	return {
		path: hit.path,
		title: hit.title,
		purpose: hit.purpose,
		anchors: hit.anchors.map(a => ({ kind: a.kind, text: a.text })),
		score: hit.score,
	};
}

/** Inputs to in-context filtering. */
export interface FilterInputs {
	/** Workspace-relative file paths already referenced in the session. */
	inContextPaths: ReadonlySet<string>;
	/** Fingerprints (`fingerprint(text)`) of the current LLM-bound messages. */
	contentFingerprints: ReadonlySet<string>;
}

/**
 * Drop candidates already in context.
 *
 * A candidate is removed when its file path is in `inContextPaths`, or when the
 * fingerprint of its identifying text (title + anchor texts) already appears in
 * the current messages — i.e. the substance is already quoted upstream.
 */
export function filterInContext(
	candidates: readonly SuggestionCandidate[],
	inputs: FilterInputs,
): SuggestionCandidate[] {
	return candidates.filter(candidate => !isAlreadyInContext(candidate, inputs));
}

/** True when a candidate's path or content fingerprint is already in context. */
function isAlreadyInContext(candidate: SuggestionCandidate, inputs: FilterInputs): boolean {
	if (inputs.inContextPaths.has(candidate.path)) return true;
	return inputs.contentFingerprints.has(candidateFingerprint(candidate));
}

/** Fingerprint a candidate's identity text (for the in-context dedupe set). */
export function candidateFingerprint(candidate: SuggestionCandidate): string {
	return fingerprint(candidateIdentity(candidate));
}

/** The normalised single-line identifying text for a candidate. */
function candidateIdentity(candidate: SuggestionCandidate): string {
	const anchorText = candidate.anchors.map(a => a.text).join(" ");
	const title = candidate.title ?? "";
	return `${title} ${anchorText}`.trim();
}

/**
 * Fingerprint a block of text for in-context dedupe.
 *
 * Normalises whitespace and case, then applies a fast non-cryptographic djb2
 * hash. Two blocks with the same substantive content collide; incidental
 * formatting differences do not. Stable and dependency-free.
 */
export function fingerprint(text: string): string {
	const normalised = text.trim().toLowerCase().replace(/\s+/g, " ");
	let hash = 5381;
	for (let i = 0; i < normalised.length; i++) {
		hash = ((hash << 5) + hash + normalised.charCodeAt(i)) | 0;
	}
	return `fp:${hash >>> 0}`;
}

/** Build the message-fingerprint set the filter consumes, from message texts. */
export function messageFingerprints(messages: readonly string[]): Set<string> {
	return new Set(messages.filter(text => text.trim().length > 0).map(fingerprint));
}
