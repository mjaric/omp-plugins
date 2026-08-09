/**
 * Hand-rolled TOML reader/writer for `.forge.toml`.
 *
 * Supports only the subset forge needs: string values, inline tables
 * (`{ k = "v", ... }`), string arrays (`["a", "b"]`), and `[[projects]]`
 * array-of-table blocks. Comments (`# ...`) and blank lines are stripped.
 */

export interface StatusOptions {
	backlog: string;
	ready: string;
	inProgress: string;
	inReview: string;
	done: string;
}

export interface ProjectConfig {
	path: string;
	repo: string;
	projectId: string;
	statusFieldId: string;
	statusOptions: StatusOptions;
	gate: string[];
	sliceFieldId?: string;
	sliceLabelPrefix?: string;
	specIdPrefix?: string;
	specIndex?: string;
	worktreeRoot?: string;
}

/** Single-project config: one repo, one board, flat fields. */
export interface SingleProjectConfig extends Omit<ProjectConfig, "path"> {}

/** Multi-project config: workspace root + array of project entries. */
export interface MultiProjectConfig {
	workspace: { type: "submodules" };
	projects: ProjectConfig[];
}

/** Forge config is either single-project or multi-project. */
export type ForgeConfig = SingleProjectConfig | MultiProjectConfig;

// --- Parser helpers ---

/** Strip comments and whitespace from a line, preserving strings. */
function stripComment(line: string): string {
	let result = "";
	let inString = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"' && line[i - 1] !== "\\") {
			inString = !inString;
		}
		if (char === "#" && !inString) {
			break;
		}
		result += char;
	}
	return result.trim();
}

/** Parse `"value"` into `value`. */
function parseStringValue(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
		throw new Error(`expected quoted string, got: ${trimmed}`);
	}
	return trimmed.slice(1, -1);
}

/** Parse `["a", "b", "c"]` into `string[]`. */
function parseStringArray(raw: string): string[] {
	const inner = raw.trim().slice(1, -1).trim();
	if (inner.length === 0) {
		return [];
	}
	return inner.split(",").map((s) => parseStringValue(s.trim()));
}

/** Parse `{ backlog = "a", ready = "b" }` into `Record<string, string>`. */
function parseInlineTable(raw: string): Record<string, string> {
	const inner = raw.trim().slice(1, -1).trim();
	if (inner.length === 0) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const pair of inner.split(",")) {
		const eqIndex = pair.indexOf("=");
		if (eqIndex === -1) {
			throw new Error(`malformed inline table pair: ${pair}`);
		}
		const key = pair.slice(0, eqIndex).trim();
		const value = parseStringValue(pair.slice(eqIndex + 1));
		result[key] = value;
	}
	return result;
}

function toStatusOptions(raw: Record<string, string>): StatusOptions {
	const require = (key: string): string => {
		const val = raw[key];
		if (val === undefined) {
			throw new Error(`missing required status option: ${key}`);
		}
		return val;
	};
	return {
		backlog: require("backlog"),
		ready: require("ready"),
		inProgress: require("in_progress"),
		inReview: require("in_review"),
		done: require("done"),
	};
}

/** Set an optional field on a config object only when value is defined. */
function setOptional(
	obj: SingleProjectConfig | ProjectConfig,
	key: "sliceFieldId" | "sliceLabelPrefix" | "specIdPrefix" | "specIndex" | "worktreeRoot",
	value: string | undefined,
): void {
	if (value !== undefined) {
		obj[key] = value;
	}
}

function buildProjectConfig(map: Record<string, string>): ProjectConfig {
	const requireField = (key: string): string => {
		const raw = map[key];
		if (raw === undefined) {
			throw new Error(`missing required field: ${key}`);
		}
		return parseStringValue(raw);
	};

	const optionalString = (key: string): string | undefined =>
		map[key] !== undefined ? parseStringValue(map[key]) : undefined;

	const requireRaw = (key: string): string => {
		const raw = map[key];
		if (raw === undefined) {
			throw new Error(`missing required field: ${key}`);
		}
		return raw;
	};

	const config: ProjectConfig = {
		path: optionalString("path") ?? "",
		repo: requireField("repo"),
		projectId: requireField("project_id"),
		statusFieldId: requireField("status_field_id"),
		statusOptions: toStatusOptions(parseInlineTable(requireRaw("status_options"))),
		gate: parseStringArray(requireRaw("gate")),
	};

	setOptional(config, "sliceFieldId", optionalString("slice_field_id"));
	setOptional(config, "sliceLabelPrefix", optionalString("slice_label_prefix"));
	setOptional(config, "specIdPrefix", optionalString("spec_id_prefix"));
	setOptional(config, "specIndex", optionalString("spec_index"));
	setOptional(config, "worktreeRoot", optionalString("worktree_root"));

	return config;
}

/** Collect key=value pairs from a line range into a flat map. */
function collectKeyValuePairs(
	lines: string[],
	start: number,
	end: number,
): Record<string, string> {
	const map: Record<string, string> = {};
	for (let i = start; i < end; i++) {
		const line = lines[i];
		if (line === undefined || line.startsWith("[")) {
			break;
		}
		const eqIndex = line.indexOf("=");
		if (eqIndex === -1) {
			continue;
		}
		const key = line.slice(0, eqIndex).trim();
		const value = line.slice(eqIndex + 1).trim();
		map[key] = value;
	}
	return map;
}

// --- Parser ---

export function parseForgeToml(toml: string): ForgeConfig {
	const lines = toml.split("\n").map(stripComment).filter((l) => l.length > 0);

	const projectBlockIndices: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === "[[projects]]") {
			projectBlockIndices.push(i);
		}
	}

	if (projectBlockIndices.length > 0) {
		return parseMultiProject(lines, projectBlockIndices);
	}

	const map = collectKeyValuePairs(lines, 0, lines.length);
	const project = buildProjectConfig(map);

	const result: SingleProjectConfig = {
		repo: project.repo,
		projectId: project.projectId,
		statusFieldId: project.statusFieldId,
		statusOptions: project.statusOptions,
		gate: project.gate,
	};
	setOptional(result, "sliceFieldId", project.sliceFieldId);
	setOptional(result, "sliceLabelPrefix", project.sliceLabelPrefix);
	setOptional(result, "specIdPrefix", project.specIdPrefix);
	setOptional(result, "specIndex", project.specIndex);
	setOptional(result, "worktreeRoot", project.worktreeRoot);
	return result;
}

function parseMultiProject(lines: string[], blockStarts: number[]): MultiProjectConfig {
	const projects: ProjectConfig[] = [];

	for (let b = 0; b < blockStarts.length; b++) {
		const start = blockStarts[b];
		if (start === undefined) {
			continue;
		}
		const nextStart = blockStarts[b + 1];
		const end = nextStart !== undefined ? nextStart : lines.length;
		const map = collectKeyValuePairs(lines, start + 1, end);
		projects.push(buildProjectConfig(map));
	}

	return { workspace: { type: "submodules" }, projects };
}

// --- Serializer ---

function serializeStatusOptions(opts: StatusOptions): string {
	const pairs = [
		`backlog = "${opts.backlog}"`,
		`ready = "${opts.ready}"`,
		`in_progress = "${opts.inProgress}"`,
		`in_review = "${opts.inReview}"`,
		`done = "${opts.done}"`,
	];
	return `{ ${pairs.join(", ")} }`;
}

function serializeGate(gate: string[]): string {
	if (gate.length === 0) {
		return "[]";
	}
	return `[${gate.map((g) => `"${g}"`).join(", ")}]`;
}

function serializeSingleFields(config: SingleProjectConfig | ProjectConfig): string[] {
	const lines: string[] = [];
	lines.push(`repo = "${config.repo}"`);
	lines.push(`project_id = "${config.projectId}"`);
	lines.push(`status_field_id = "${config.statusFieldId}"`);
	lines.push(`status_options = ${serializeStatusOptions(config.statusOptions)}`);
	lines.push(`gate = ${serializeGate(config.gate)}`);
	if (config.sliceFieldId !== undefined) {
		lines.push(`slice_field_id = "${config.sliceFieldId}"`);
	}
	if (config.sliceLabelPrefix !== undefined) {
		lines.push(`slice_label_prefix = "${config.sliceLabelPrefix}"`);
	}
	if (config.specIdPrefix !== undefined) {
		lines.push(`spec_id_prefix = "${config.specIdPrefix}"`);
	}
	if (config.specIndex !== undefined) {
		lines.push(`spec_index = "${config.specIndex}"`);
	}
	if (config.worktreeRoot !== undefined) {
		lines.push(`worktree_root = "${config.worktreeRoot}"`);
	}
	return lines;
}

export function serializeForgeToml(config: ForgeConfig): string {
	if ("projects" in config) {
		const lines: string[] = ["# .forge.toml — generated by `forge setup`", ""];
		lines.push("[workspace]");
		lines.push(`type = "${config.workspace.type}"`);
		lines.push("");
		for (const project of config.projects) {
			lines.push("[[projects]]");
			lines.push(`path = "${project.path}"`);
			lines.push(...serializeSingleFields(project));
			lines.push("");
		}
		return lines.join("\n");
	}

	const lines: string[] = ["# .forge.toml — generated by `forge setup`", ""];
	lines.push(...serializeSingleFields(config));
	return lines.join("\n") + "\n";
}
