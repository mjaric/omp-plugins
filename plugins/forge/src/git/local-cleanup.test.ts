import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupAfterMerge, formatCleanupReport } from "./local-cleanup";

let dir: string;

/** Run a git command in the temp repo, failing loudly.
 *
 * Async `Bun.spawn` — the sync variants (Bun.spawnSync and
 * node:child_process.spawnSync) silently return exit 1 with empty
 * output when bun test runs many files in parallel workers
 * (observed on Bun 1.3.14). */
async function git(args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd: dir });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = (await new Response(proc.stderr).text()).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr} cwd=${dir}`);
	}
}

/** Scaffold a repo with a merged feature branch and its worktree. */
async function scaffoldRepo(): Promise<void> {
	await git(["init", "--initial-branch", "main"]);
	await git(["config", "user.email", "test@test.local"]);
	await git(["config", "user.name", "Test"]);
	writeFileSync(join(dir, "file.txt"), "base\n");
	await git(["add", "."]);
	await git(["commit", "-m", "init"]);
	await git(["branch", "impl/5-merged-thing"]);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "forge-cleanup-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("cleanupAfterMerge", () => {
	it("deletes merged branches including squash-merge head refs", async () => {
		await scaffoldRepo();
		const report = await cleanupAfterMerge(dir, []);
		expect(report.branchesDeleted).toContain("impl/5-merged-thing");
		expect(report.branchesDeleted).not.toContain("main");
	});

	it("removes worktrees on merged head refs that git cannot see as merged", async () => {
		await scaffoldRepo();
		await git(["branch", "pr-19"]);
		await git(["worktree", "add", join(dir, "wt-pr19"), "pr-19"]);
		// pr-19 is not merged per git, but passed as a squash-merged head ref.
		const report = await cleanupAfterMerge(dir, ["pr-19"]);
		expect(report.worktreesRemoved).toHaveLength(1);
		expect(report.branchesDeleted).toContain("pr-19");
	});

	it("skips dirty worktrees instead of forcing removal", async () => {
		await scaffoldRepo();
		await git(["worktree", "add", join(dir, "wt-dirty"), "impl/5-merged-thing"]);
		writeFileSync(join(dir, "wt-dirty", "dirty.txt"), "uncommitted\n");
		const report = await cleanupAfterMerge(dir, []);
		expect(report.worktreesRemoved).toEqual([]);
		expect(report.branchesDeleted).not.toContain("impl/5-merged-thing");
		expect(report.skipped.length).toBe(1);
		expect(report.skipped[0]?.reason).toContain("uncommitted");
	});

	it("never touches the main worktree or branch", async () => {
		await scaffoldRepo();
		const report = await cleanupAfterMerge(dir, ["main"]);
		expect(report.branchesDeleted).not.toContain("main");
		expect(report.worktreesRemoved).toEqual([]);
	});

	it("returns an empty report for a non-git directory", async () => {
		const report = await cleanupAfterMerge("/tmp", []);
		expect(report.branchesDeleted).toEqual([]);
		expect(report.worktreesRemoved).toEqual([]);
	});
});

describe("formatCleanupReport", () => {
	it("says nothing to remove when the report is empty", () => {
		expect(formatCleanupReport({ worktreesRemoved: [], branchesDeleted: [], skipped: [], remotesPruned: false }))
			.toContain("nothing to remove");
	});

	it("lists removed worktrees and deleted branches", () => {
		const out = formatCleanupReport({
			worktreesRemoved: ["/tmp/wt"],
			branchesDeleted: ["impl/5-x"],
			skipped: [{ ref: "/tmp/dirty", reason: "uncommitted changes" }],
			remotesPruned: true,
		});
		expect(out).toContain("/tmp/wt");
		expect(out).toContain("impl/5-x");
		expect(out).toContain("Skipped /tmp/dirty: uncommitted changes");
		expect(out).toContain("pruned");
	});
});
