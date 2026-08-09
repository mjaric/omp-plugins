/**
 * Relation extraction and inline bracket scanning (spec §5.2–5.3).
 *
 * Two sources of typed edges:
 *  - **Frontmatter** `relations:` — explicit `"[ID-A] verb [ID-B]"` strings.
 *  - **Inline** bracket references — `[C4]` in body text becomes a `mentions`
 *    edge from the file to that entity (gated by the active profile's
 *    namespaces).
 *
 * Also captures **definition-site** candidates (table first-cell, heading,
 * bold) used by the resolution pass to pin `entity.def_file_id`.
 */

import type { DefinitionSite, ParsedHeading, ParsedRelation, Profile } from "../types";

/** Bracket-ID pattern: `[NS]number[.sub]` e.g. `[C4]`, `[RQ2.1]`, `[SP7]`. */
export const BRACKET_ID_RE = /\[([A-Za-z]{1,10})(\d+(?:\.\d+)?)\]/g;

/** Frontmatter relation: `[src] verb [dst]` (lenient brackets for opaque IDs). */
const RELATION_RE = /\[([^\]]+)\]\s+(.+?)\s+\[([^\]]+)\]/;

/** Build the canonical entity name from a namespace prefix and number. */
export function entityName(namespace: string, number: string): string {
	return `${namespace}${number}`;
}

/** Normalise a raw verb into a relation type: lowercase, hyphenated. */
export function normalizeVerb(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Parse a single frontmatter relation string into a typed edge. */
export function parseFrontmatterRelation(raw: string, sourceLine: number): ParsedRelation | null {
	const match = raw.match(RELATION_RE);
	if (!match) return null;
	const srcEntity = match[1]!.trim();
	const verbRaw = match[2]!.trim();
	const dstEntity = match[3]!.trim();
	if (verbRaw.length === 0) return null;
	return {
		srcEntity,
		verbRaw,
		dstEntity,
		type: normalizeVerb(verbRaw),
		origin: "frontmatter",
		sourceLine,
	};
}

/** Parse all frontmatter relation strings into typed edges. */
export function parseFrontmatterRelations(raws: readonly string[]): ParsedRelation[] {
	const out: ParsedRelation[] = [];
	for (const raw of raws) {
		const rel = parseFrontmatterRelation(raw, 0);
		if (rel) out.push(rel);
	}
	return out;
}

/** Result of an inline bracket scan over body lines. */
export interface InlineScanResult {
	relations: ParsedRelation[];
	entityRefs: string[];
}

/**
 * Scan body lines for inline bracket references, producing `mentions` edges
 * and collecting referenced entity names. No-op when the profile has inline
 * scanning disabled.
 */
export function scanInlineRefs(lines: readonly string[], profile: Profile): InlineScanResult {
	if (!profile.scanInline || profile.namespaces.length === 0) {
		return { relations: [], entityRefs: [] };
	}
	const relations: ParsedRelation[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		for (const m of matchAll(BRACKET_ID_RE, lines[i]!)) {
			const ns = m[1];
			const num = m[2];
			if (!ns || !num || !profile.namespaces.includes(ns)) continue;
			const name = entityName(ns, num);
			seen.add(name);
			relations.push({
				srcEntity: null,
				verbRaw: "mentions",
				dstEntity: name,
				type: "mentions",
				origin: "inline",
				sourceLine: i,
			});
		}
	}
	return { relations, entityRefs: [...seen] };
}

/** Scan body lines + headings for entity definition-site candidates. */
export function scanDefinitionSites(
	lines: readonly string[],
	headings: readonly ParsedHeading[],
	profile: Profile,
): DefinitionSite[] {
	if (!profile.scanInline || profile.namespaces.length === 0) return [];
	const sites: DefinitionSite[] = [];
	const nsRe = namespacePattern(profile);
	for (const h of headings) {
		const m = h.text.match(nsRe);
		if (m && m[1]) sites.push({ name: m[1], line: h.startLine, kind: "heading" });
	}
	for (let i = 0; i < lines.length; i++) {
		scanLineForDefinitions(lines[i]!, i, nsRe, sites);
	}
	return dedupeByName(sites);
}

/** Build a regex matching any profile namespace followed by a number. */
function namespacePattern(profile: Profile): RegExp {
	const alts = profile.namespaces.join("|");
	return new RegExp(`\\b((${alts})(\\d+(?:\\.\\d+)?))\\b`);
}

/** Scan one body line for table-first-cell and bold definition sites. */
function scanLineForDefinitions(
	line: string,
	lineNo: number,
	nsRe: RegExp,
	sites: DefinitionSite[],
): void {
	const tableMatch = line.match(/^\|\s*([^|]+?)\s*\|/);
	if (tableMatch) {
		const cell = tableMatch[1]!;
		const m = cell.match(nsRe);
		if (m && m[1]) sites.push({ name: m[1], line: lineNo, kind: "table" });
	}
	const boldRe = /\*\*([^*]+?)\*\*/g;
	for (const m of matchAll(boldRe, line)) {
		const inner = m[1];
		if (!inner) continue;
		const id = inner.match(nsRe);
		if (id && id[1]) sites.push({ name: id[1], line: lineNo, kind: "bold" });
	}
}

/** Keep the first definition site per entity name (first-seen wins). */
function dedupeByName(sites: DefinitionSite[]): DefinitionSite[] {
	const out: DefinitionSite[] = [];
	const seen = new Set<string>();
	for (const s of sites) {
		if (seen.has(s.name)) continue;
		seen.add(s.name);
		out.push(s);
	}
	return out;
}

/** Generator over all regex matches on a string (resets lastIndex). */
function* matchAll(re: RegExp, input: string): Generator<RegExpMatchArray> {
	const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
	let m: RegExpExecArray | null;
	while ((m = global.exec(input)) !== null) {
		yield m;
		if (m.index === global.lastIndex) global.lastIndex++;
	}
}
