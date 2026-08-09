/**
 * Heading outline parser — ATX headings (`#`–`######`) with nesting.
 *
 * Produces a flat array with `parentIndex` linking each heading to the last
 * heading at a shallower depth, so the tree is reconstructable without
 * recursion. Line-oriented; matches the hand-rolled parser decision (§13).
 */

import type { ParsedHeading } from "../types";

/** ATX heading regex: 1–6 `#`, optional space, text, trailing `#`s allowed. */
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Build a slug from heading text (GitHub-style: lowercase, hyphenated). */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Parse all ATX headings from document lines with parent linkage. */
export function parseOutline(lines: readonly string[]): ParsedHeading[] {
	const headings: ParsedHeading[] = [];
	const stack: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]!.match(HEADING_RE);
		if (!match) continue;
		const depth = match[1]!.length;
		const text = match[2]!.trim();
		if (text.length === 0) continue;
		while (stack.length > 0 && depthOf(stack, headings) >= depth) stack.pop();
		headings.push({
			depth,
			text,
			slug: slugify(text),
			startLine: i,
			parentIndex: stack.length > 0 ? stack[stack.length - 1]! : null,
		});
		stack.push(headings.length - 1);
	}
	return headings;
}

/** Depth of the heading at the top of the stack. */
function depthOf(stack: number[], headings: ParsedHeading[]): number {
	const topIdx = stack[stack.length - 1];
	return topIdx !== undefined ? headings[topIdx]!.depth : 0;
}
