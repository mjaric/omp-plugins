/**
 * Frontmatter parser — a focused YAML subset, not a general YAML parser.
 *
 * Handles only the shapes the annotation convention (spec §5.1) uses:
 * `key: value` scalars, `key: [a, b]` inline arrays, and `key:` block lists.
 * Unknown structures are ignored rather than throwing.
 */

import type { ParsedFrontmatter } from "../types";

/** Empty frontmatter (used when no valid block is present). */
export const EMPTY_FRONTMATTER: ParsedFrontmatter = {
	title: null,
	purpose: null,
	entities: [],
	relations: [],
};

/**
 * Extract the frontmatter block from document text.
 * Returns the raw block lines (without the `---` fences) or null.
 */
export function extractFrontmatterBlock(lines: readonly string[]): string[] | null {
	if (lines.length === 0 || lines[0]!.trim() !== "---") return null;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === "---") return lines.slice(1, i);
	}
	return null;
}

/** Strip surrounding quotes and whitespace from a scalar value. */
function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if (first === '"' && last === '"') return trimmed.slice(1, -1);
	if (first === "'" && last === "'") return trimmed.slice(1, -1);
	return trimmed;
}

/** Parse an inline array value `[a, b, c]` into trimmed string items. */
function parseInlineArray(value: string): string[] {
	const inner = value.trim();
	if (!inner.startsWith("[") || !inner.endsWith("]")) return [];
	return inner
		.slice(1, -1)
		.split(",")
		.map(item => unquote(item))
		.filter(item => item.length > 0);
}

/** Parse a block list (consecutive `  - item` lines) starting at `startIdx`. */
function parseBlockList(block: readonly string[], startIdx: number): [string[], number] {
	const items: string[] = [];
	let i = startIdx;
	while (i < block.length) {
		const line = block[i]!.trimStart();
		if (line.startsWith("- ")) {
			items.push(unquote(line.slice(2)));
		} else if (line !== "-") {
			break;
		}
		i++;
	}
	return [items, i];
}

/**
 * Parse the frontmatter block into typed fields.
 * Missing or malformed fields fall back to empty/null defaults.
 */
export function parseFrontmatter(block: readonly string[]): ParsedFrontmatter {
	const result: ParsedFrontmatter = { ...EMPTY_FRONTMATTER };
	let i = 0;
	while (i < block.length) {
		const line = block[i]!;
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) {
			i++;
			continue;
		}
		const key = line.slice(0, colonIdx).trim();
		const rest = line.slice(colonIdx + 1).trim();
		i = applyField(result, key, rest, block, i);
	}
	return result;
}

/** Set one frontmatter field, returning the next line index. */
function applyField(
	result: ParsedFrontmatter,
	key: string,
	rest: string,
	block: readonly string[],
	idx: number,
): number {
	if (key === "title") {
		result.title = unquote(rest) || null;
		return idx + 1;
	}
	if (key === "purpose") {
		result.purpose = unquote(rest) || null;
		return idx + 1;
	}
	if (key === "entities" || key === "relations") {
		return applyListField(result, key, rest, block, idx);
	}
	return idx + 1;
}

/** Apply a list-valued field (entities or relations). */
function applyListField(
	result: ParsedFrontmatter,
	key: "entities" | "relations",
	rest: string,
	block: readonly string[],
	idx: number,
): number {
	let items: string[];
	let next: number;
	if (rest.startsWith("[")) {
		items = parseInlineArray(rest);
		next = idx + 1;
	} else if (rest.length === 0) {
		[items, next] = parseBlockList(block, idx + 1);
	} else {
		return idx + 1;
	}
	if (key === "entities") result.entities = items;
	else result.relations = items;
	return next;
}
