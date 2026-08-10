/**
 * Skill template installation for `/forge setup`.
 *
 * Copies the bundled `sdlc` and `forge-retrospect` skill templates into
 * the project's `.omp/skills/` so the project owns them from then on
 * (the user edits `rules/`, `references/`, and the SKILL.md body).
 * Existing skill directories are never overwritten.
 */

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Bundled template dir → project skill dir name. */
const SKILL_TARGETS: Record<string, string> = {
	"sdlc-skill": "sdlc",
	"retrospect-skill": "forge-retrospect",
};

/** Which templates were installed and which were left alone. */
export interface SkillInstallReport {
	installed: string[];
	skipped: string[];
}

/**
 * Copy skill templates from `templatesRoot` into `<cwd>/.omp/skills/`.
 *
 * A template is skipped when its source directory is missing (best
 * effort — a packaging gap must not break setup) or when the target
 * skill directory already exists (never overwrite user edits).
 */
export function installSkillTemplates(
	templatesRoot: string,
	cwd: string,
): SkillInstallReport {
	const installed: string[] = [];
	const skipped: string[] = [];

	for (const [templateDir, skillName] of Object.entries(SKILL_TARGETS)) {
		const source = join(templatesRoot, templateDir);
		const target = join(cwd, ".omp", "skills", skillName);
		if (!existsSync(source) || existsSync(target)) {
			skipped.push(skillName);
			continue;
		}
		cpSync(source, target, { recursive: true });
		installed.push(skillName);
	}

	return { installed, skipped };
}

/** Format an install report for a setup notification. */
export function formatSkillInstallReport(report: SkillInstallReport): string {
	const parts: string[] = [];
	if (report.installed.length > 0) {
		parts.push(`installed skills: ${report.installed.join(", ")}`);
	}
	if (report.skipped.length > 0) {
		parts.push(`kept existing: ${report.skipped.join(", ")}`);
	}
	return `forge setup: ${parts.length > 0 ? parts.join("; ") : "no skill templates found"}.`;
}
