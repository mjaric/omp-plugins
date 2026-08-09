/**
 * Markdown parser orchestrator — the single parsing entry point.
 *
 * Combines frontmatter, heading outline, relation extraction, inline bracket
 * scanning, and definition-site detection into one {@link ParsedFile}.
 *
 * Gate-0 decision (§13): hand-rolled line-oriented parser. `web-tree-sitter`
 * fails to initialise under Bun and requires a network-fetched grammar; the
 * annotation convention is line-oriented so a hand-rolled parser is exact.
 */

import type { DefinitionSite, ParsedFile, ParsedRelation, Profile } from "../types";
import { EMPTY_FRONTMATTER, extractFrontmatterBlock, parseFrontmatter } from "./frontmatter";
import { parseOutline } from "./outline";
import {
	parseFrontmatterRelations,
	scanDefinitionSites,
	scanInlineRefs,
} from "./relations";

/**
 * Parse a markdown document into graph-ready structures.
 *
 * Line numbers in the output are 0-indexed and absolute (from the file's first
 * line). Frontmatter and fenced-code-block content are blanked before outline
 * and bracket scanning so neither produces false positives.
 */
export function parseMarkdown(content: string, relPath: string, profile: Profile): ParsedFile {
	const rawLines = content.split("\n");
	const fmBlock = extractFrontmatterBlock(rawLines);
	const scanLines = buildScanLines(rawLines);

	const frontmatter = fmBlock ? parseFrontmatter(fmBlock) : { ...EMPTY_FRONTMATTER };
	const headings = parseOutline(scanLines);
	const fmRelations = parseFrontmatterRelations(frontmatter.relations);
	const inline = scanInlineRefs(scanLines, profile);
	const scannedSites = scanDefinitionSites(scanLines, headings, profile);
	const definitionSites = mergeDefinitionSites(scannedSites, frontmatter.entities);
	const entityRefs = collectEntityRefs(frontmatter.entities, inline.entityRefs, fmRelations);

	return {
		path: relPath,
		title: frontmatter.title ?? (headings[0]?.text ?? null),
		frontmatter,
		headings,
		relations: [...fmRelations, ...inline.relations],
		entityRefs,
		definitionSites,
	};
}

/** Merge scanned definition sites with frontmatter-declared entities. */
function mergeDefinitionSites(
	scanned: readonly DefinitionSite[],
	declared: readonly string[],
): DefinitionSite[] {
	const merged = [...scanned];
	const existing = new Set(scanned.map(s => s.name));
	for (const name of declared) {
		if (!existing.has(name)) merged.push({ name, line: 0, kind: "frontmatter" });
	}
	return merged;
}

/** Collect all distinct entity names referenced or declared by this file. */
function collectEntityRefs(
	declared: readonly string[],
	inlineRefs: readonly string[],
	relations: readonly ParsedRelation[],
): string[] {
	const set = new Set<string>();
	for (const e of declared) set.add(e);
	for (const e of inlineRefs) set.add(e);
	for (const r of relations) {
		if (r.srcEntity) set.add(r.srcEntity);
		if (r.dstEntity) set.add(r.dstEntity);
	}
	return [...set];
}

/**
 * Produce a copy of the document lines with frontmatter and fenced code
 * blocks blanked, preserving absolute line indices for reference tracking.
 */
function buildScanLines(rawLines: readonly string[]): string[] {
	const out = rawLines.slice();
	blankFrontmatter(out);
	blankCodeFences(out);
	return out;
}

/** Blank the frontmatter block (lines[0..closing `---`]) if present. */
function blankFrontmatter(lines: string[]): void {
	if (lines.length === 0 || lines[0]!.trim() !== "---") return;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === "---") {
			for (let j = 0; j <= i; j++) lines[j] = "";
			return;
		}
	}
}

/** Blank lines inside ``` or ~~~ fenced code blocks. */
function blankCodeFences(lines: string[]): void {
	let inFence = false;
	let marker = "";
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trimStart();
		const fence = fenceMarker(trimmed);
		if (fence !== null) {
			if (!inFence) {
				inFence = true;
				marker = fence;
			} else if (fence === marker) {
				inFence = false;
				marker = "";
			}
			lines[i] = "";
		} else if (inFence) {
			lines[i] = "";
		}
	}
}

/** Return the fence marker (``` or ~~~) if the line opens/closes a block. */
function fenceMarker(trimmedLine: string): string | null {
	if (trimmedLine.startsWith("```")) return "```";
	if (trimmedLine.startsWith("~~~")) return "~~~";
	return null;
}
