/**
 * Shared domain types for the file-graph indexer.
 *
 * These are the pure data shapes that flow between the parser, store,
 * resolution, and query layers. No I/O, no omp-runtime types live here.
 */

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** A parsing/namespace profile. Profiles are data, not code branches. */
export interface Profile {
	readonly name: "generic" | "zksrc";
	/** Bracket-namespace prefixes that the inline scanner recognises. */
	readonly namespaces: readonly string[];
	/** Whether inline bracket references are scanned at all. */
	readonly scanInline: boolean;
}

// ---------------------------------------------------------------------------
// Parser output
// ---------------------------------------------------------------------------

/** Frontmatter fields parsed from the YAML block (best-effort subset). */
export interface ParsedFrontmatter {
	title: string | null;
	purpose: string | null;
	/** Canonical terms this document owns (from `entities:`). */
	entities: string[];
	/** Raw relation strings (`"[SP7] gates [C13]"`). */
	relations: string[];
}

/** A single ATX heading with its position in the document outline. */
export interface ParsedHeading {
	depth: number;
	text: string;
	slug: string;
	startLine: number;
	/** Index of the parent heading in the file's array, or null for roots. */
	parentIndex: number | null;
}

/** A definition-site candidate for an entity ID (zksrc-style resolution). */
export interface DefinitionSite {
	/** Entity name, e.g. "C4". */
	name: string;
	line: number;
	kind: "table" | "heading" | "bold" | "frontmatter";
}

/** A typed edge extracted from frontmatter or inline references. */
export interface ParsedRelation {
	/** Source entity name, or null when the source is the file itself (inline). */
	srcEntity: string | null;
	verbRaw: string;
	/** Destination entity name, or null when unresolvable. */
	dstEntity: string | null;
	/** Normalised type: lowercased, kebab-cased verb (or "mentions"). */
	type: string;
	origin: "frontmatter" | "inline";
	sourceLine: number;
}

/** Full parse result for one markdown file. */
export interface ParsedFile {
	/** Workspace-relative path. */
	path: string;
	/** Effective display title: frontmatter `title`, else first heading. */
	title: string | null;
	frontmatter: ParsedFrontmatter;
	headings: ParsedHeading[];
	relations: ParsedRelation[];
	/** Entity IDs referenced inline or declared in frontmatter. */
	entityRefs: string[];
	/** Definition-site candidates found in the body. */
	definitionSites: DefinitionSite[];
}

// ---------------------------------------------------------------------------
// Store rows
// ---------------------------------------------------------------------------

export interface FileRow {
	id: number;
	path: string;
	mtimeMs: number;
	contentHash: string;
	title: string | null;
	purpose: string | null;
	indexedAt: number;
}

export interface HeadingRow {
	id: number;
	fileId: number;
	depth: number;
	text: string;
	slug: string;
	parentId: number | null;
	startLine: number;
}

export interface EntityRow {
	id: number;
	name: string;
	namespace: string | null;
	definition: string | null;
	defFileId: number | null;
	firstSeen: number;
	lastSeen: number;
}

export interface RelationRow {
	id: number;
	srcFileId: number;
	srcEntityId: number | null;
	dstFileId: number | null;
	dstEntityId: number | null;
	type: string;
	verbRaw: string;
	confidence: number;
	sourceLine: number;
	origin: "frontmatter" | "inline";
}

// ---------------------------------------------------------------------------
// Query / results
// ---------------------------------------------------------------------------

/** A searchable text fragment tied to a file (indexed in FTS or LIKE table). */
export interface SearchDoc {
	fileId: number;
	kind: "title" | "purpose" | "heading" | "entity";
	text: string;
	line: number | null;
}

/** A ranked search hit. */
export interface SearchHit {
	fileId: number;
	path: string;
	title: string | null;
	purpose: string | null;
	score: number;
	anchors: SearchAnchor[];
	/** Relation context discovered via graph expansion. */
	relations: SearchRelationEdge[];
}

export interface SearchAnchor {
	kind: "title" | "purpose" | "heading" | "entity";
	text: string;
	line: number | null;
}

export interface SearchRelationEdge {
	type: string;
	direction: "out" | "in";
	target: string;
}

/** Result of the entity definition-site resolution pass. */
export interface ResolveReport {
	/** Entity names that could not be resolved to a definition file. */
	dangling: string[];
	/** Files missing a `purpose` frontmatter field. */
	missingPurpose: string[];
	/** Total entity count after resolution. */
	entityCount: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** One OpenAI-compatible rerank/endpoint entry in the endpoint chain. */
export interface EndpointConfig {
	name: string;
	baseUrl: string;
	apiKey?: string;
	model: string;
}

/** Plugin configuration, persisted in the store `meta` table. */
export interface FileGraphConfig {
	profile: "generic" | "zksrc";
	/** Inline-scan namespaces (overrides profile defaults when non-empty). */
	namespaces: string[];
	rerankEnabled: boolean;
	rerankTopN: number;
	endpoints: EndpointConfig[];
}

/** Default config: rerank off, generic profile, no endpoints. */
export const DEFAULT_CONFIG: FileGraphConfig = {
	profile: "generic",
	namespaces: [],
	rerankEnabled: false,
	rerankTopN: 12,
	endpoints: [],
};
