import { describe, expect, it, afterEach } from "bun:test";
import { installSkillTemplates, formatSkillInstallReport } from "./install-skills";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cleanups: string[] = [];
afterEach(() => {
	for (const p of cleanups.splice(0)) {
		rmSync(p, { recursive: true, force: true });
	}
});

/** Create a fake templates root with both skill templates. */
function makeTemplatesRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "forge-templates-"));
	cleanups.push(root);
	mkdirSync(join(root, "sdlc-skill", "rules"), { recursive: true });
	mkdirSync(join(root, "retrospect-skill"), { recursive: true });
	writeFileSync(join(root, "sdlc-skill", "SKILL.md"), "# sdlc");
	writeFileSync(join(root, "sdlc-skill", "rules", "README.md"), "# rules");
	writeFileSync(join(root, "retrospect-skill", "SKILL.md"), "# retrospect");
	return root;
}

function makeProject(): string {
	const project = mkdtempSync(join(tmpdir(), "forge-project-"));
	cleanups.push(project);
	return project;
}

describe("installSkillTemplates", () => {
	it("copies both skills into .omp/skills", () => {
		const templates = makeTemplatesRoot();
		const project = makeProject();

		const report = installSkillTemplates(templates, project);
		expect(report.installed.sort()).toEqual(["forge-retrospect", "sdlc"]);
		expect(existsSync(join(project, ".omp", "skills", "sdlc", "SKILL.md"))).toBe(true);
		expect(existsSync(join(project, ".omp", "skills", "sdlc", "rules", "README.md"))).toBe(true);
		expect(existsSync(join(project, ".omp", "skills", "forge-retrospect", "SKILL.md"))).toBe(true);
	});

	it("never overwrites an existing skill directory", () => {
		const templates = makeTemplatesRoot();
		const project = makeProject();

		const skillDir = join(project, ".omp", "skills", "sdlc");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "# user-edited");

		const report = installSkillTemplates(templates, project);
		expect(report.installed).toEqual(["forge-retrospect"]);
		expect(report.skipped).toEqual(["sdlc"]);
		expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
	});

	it("skips missing template sources without throwing", () => {
		const project = makeProject();
		const report = installSkillTemplates(join(project, "no-such-dir"), project);
		expect(report.installed).toEqual([]);
		expect(report.skipped.sort()).toEqual(["forge-retrospect", "sdlc"]);
	});
});

describe("formatSkillInstallReport", () => {
	it("reports installed and kept skills", () => {
		const text = formatSkillInstallReport({ installed: ["sdlc"], skipped: ["forge-retrospect"] });
		expect(text).toContain("installed skills: sdlc");
		expect(text).toContain("kept existing: forge-retrospect");
	});

	it("reports when no templates were found", () => {
		const text = formatSkillInstallReport({ installed: [], skipped: [] });
		expect(text).toContain("no skill templates found");
	});
});
