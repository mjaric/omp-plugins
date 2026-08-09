import { describe, expect, it } from "bun:test";
import { parseForgeToml, serializeForgeToml, type SingleProjectConfig, type MultiProjectConfig } from "../config/forge-toml";

describe("forge-toml parser", () => {
	it("parses a minimal single-project config", () => {
		const toml = `
repo = "mjaric/smith"
project_id = "PVT_kwHOAAT9884Bf1hn"
status_field_id = "PVTSSF_lAAT9884abc"
status_options = { backlog = "bedc5e5a", ready = "2c22bc92", in_progress = "47fc9ee4", in_review = "37cbfc5d", done = "98236657" }
gate = ["cargo test", "cargo clippy --all-targets -- -D warnings"]
spec_id_prefix = "REQ"
`;
		const config = parseForgeToml(toml) as SingleProjectConfig;
		expect(config.repo).toBe("mjaric/smith");
		expect(config.projectId).toBe("PVT_kwHOAAT9884Bf1hn");
		expect(config.statusFieldId).toBe("PVTSSF_lAAT9884abc");
		expect(config.statusOptions.backlog).toBe("bedc5e5a");
		expect(config.statusOptions.done).toBe("98236657");
		expect(config.gate).toEqual(["cargo test", "cargo clippy --all-targets -- -D warnings"]);
		expect(config.specIdPrefix).toBe("REQ");
	});

	it("parses optional slice field and worktree root", () => {
		const toml = `
repo = "mjaric/smith"
project_id = "PVT_123"
status_field_id = "F1"
status_options = { backlog = "a", ready = "b", in_progress = "c", in_review = "d", done = "e" }
gate = []
slice_field_id = "F2"
slice_label_prefix = "slice-"
worktree_root = "/tmp"
`;
		const config = parseForgeToml(toml) as SingleProjectConfig;
		expect(config.sliceFieldId).toBe("F2");
		expect(config.sliceLabelPrefix).toBe("slice-");
		expect(config.worktreeRoot).toBe("/tmp");
	});

	it("parses multi-project workspace config", () => {
		const toml = `
[workspace]
type = "submodules"

[[projects]]
path = "projects/smith"
repo = "mjaric/smith"
project_id = "PVT_1"
status_field_id = "F1"
status_options = { backlog = "a", ready = "b", in_progress = "c", in_review = "d", done = "e" }
gate = ["cargo test"]

[[projects]]
path = "projects/other"
repo = "mjaric/other"
project_id = "PVT_2"
status_field_id = "F2"
status_options = { backlog = "a", ready = "b", in_progress = "c", in_review = "d", done = "e" }
gate = []
`;
		const config = parseForgeToml(toml) as MultiProjectConfig;
		expect(config.workspace).not.toBeUndefined();
		expect(config.workspace?.type).toBe("submodules");
		expect(config.projects).toHaveLength(2);
		expect(config.projects?.[0]?.path).toBe("projects/smith");
		expect(config.projects?.[1]?.repo).toBe("mjaric/other");
	});

	it("throws on missing required field", () => {
		const toml = `
repo = "mjaric/smith"
# missing project_id, status_field_id, status_options, gate
`;
		expect(() => parseForgeToml(toml)).toThrow("project_id");
	});

	it("round-trips: serialize then parse gives equivalent config", () => {
		const original: SingleProjectConfig = {
			repo: "mjaric/smith",
			projectId: "PVT_kwHOAAT9884Bf1hn",
			statusFieldId: "PVTSSF_abc",
			statusOptions: {
				backlog: "bedc5e5a",
				ready: "2c22bc92",
				inProgress: "47fc9ee4",
				inReview: "37cbfc5d",
				done: "98236657",
			},
			gate: ["cargo test", "bunx vitest"],
			specIdPrefix: "REQ",
			specIndex: "docs/AGENTS.md",
			worktreeRoot: "/tmp",
		};
		const serialized = serializeForgeToml(original);
		const reparsed = parseForgeToml(serialized);
		expect(reparsed).toEqual(original);
	});

	it("ignores comments and blank lines", () => {
		const toml = `# forge config
repo = "mjaric/smith"  # owner/name

# board
project_id = "PVT_1"
status_field_id = "F1"
status_options = { backlog = "a", ready = "b", in_progress = "c", in_review = "d", done = "e" }
gate = []  # no gate yet
`;
		const config = parseForgeToml(toml) as SingleProjectConfig;
		expect(config.repo).toBe("mjaric/smith");
	});
});
