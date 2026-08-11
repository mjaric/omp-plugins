/**
 * Local git hygiene after merges — remove leftover worktrees and
 * branches whose work already landed on the main branch.
 *
 * Two sources of "merged":
 * 1. Branches git itself reports as merged into the main worktree's
 *    branch (`git branch --merged`) — fast-forward and merge commits.
 * 2. Head refs of PRs GitHub reports as merged (`mergedHeadRefs`) —
 *    required for squash merges, which git cannot detect.
 *
 * Best effort: every failure becomes a `skipped` entry, never a throw.
 * Uses async `Bun.spawn` — both sync spawn variants misfire (exit 1,
 * empty output) when many bun test workers run in parallel.
 */

/** Result of one cleanup pass. */
export interface CleanupReport {
	worktreesRemoved: string[];
	branchesDeleted: string[];
	skipped: Array<{ ref: string; reason: string }>;
	remotesPruned: boolean;
}

/** Empty report for non-git directories. */
const NO_REPO: CleanupReport = {
	worktreesRemoved: [],
	branchesDeleted: [],
	skipped: [],
	remotesPruned: false,
};

/** Run a git command; return stdout or null on any failure. */
async function git(cwd: string, args: string[]): Promise<string | null> {
	const proc = Bun.spawn(["git", ...args], { cwd });
	const exitCode = await proc.exited;
	if (exitCode !== 0) return null;
	return new Response(proc.stdout).text();
}

/** One entry from `git worktree list --porcelain`. */
interface WorktreeEntry {
	path: string;
	branch: string | null;
	detached: boolean;
}

/** Parse `git worktree list --porcelain` output. */
function parseWorktrees(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;
	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice("worktree ".length), branch: null, detached: false };
			entries.push(current);
		} else if (line.startsWith("branch ") && current !== null) {
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		} else if (line === "detached" && current !== null) {
			current.detached = true;
		}
	}
	return entries;
}

/** Branch names git reports as merged into `mainBranch`. */
async function mergedBranches(cwd: string, mainBranch: string): Promise<string[]> {
	const output = await git(cwd, ["branch", "--merged", mainBranch]);
	if (output === null) return [];
	return output
		.split("\n")
		.map((line) => line.replace(/^[*+] /, "").trim())
		.filter((name) => name.length > 0 && name !== mainBranch);
}

/**
 * Remove merged-PR leftovers: worktrees and local branches whose work
 * landed, plus stale remote-tracking refs. The main worktree and its
 * branch are never touched; dirty worktrees are skipped, not forced.
 */
export async function cleanupAfterMerge(cwd: string, mergedHeadRefs: string[]): Promise<CleanupReport> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (root === null) return NO_REPO;

	const remotesPruned = (await git(cwd, ["remote", "prune", "origin"])) !== null;
	const worktrees = parseWorktrees((await git(cwd, ["worktree", "list", "--porcelain"])) ?? "");
	const mainEntry = worktrees[0];
	const mainBranch = mainEntry?.branch ?? null;

	const removable = new Set<string>(mergedHeadRefs);
	if (mainBranch !== null) {
		for (const name of await mergedBranches(cwd, mainBranch)) removable.add(name);
	}
	removable.delete(mainBranch ?? "");

	const report: CleanupReport = { worktreesRemoved: [], branchesDeleted: [], skipped: [], remotesPruned };
	await removeMergedWorktrees(cwd, worktrees, mainEntry?.path ?? "", removable, report);
	await deleteMergedBranches(cwd, worktrees, removable, report);
	return report;
}

/** Remove worktrees checked out on removable branches (skip dirty ones). */
async function removeMergedWorktrees(
	cwd: string,
	worktrees: WorktreeEntry[],
	mainPath: string,
	removable: Set<string>,
	report: CleanupReport,
): Promise<void> {
	for (const entry of worktrees) {
		if (entry.path === mainPath || entry.branch === null) continue;
		if (!removable.has(entry.branch)) continue;
		const dirty = (await git(cwd, ["-C", entry.path, "status", "--porcelain"])) ?? "error";
		if (dirty.trim().length > 0) {
			report.skipped.push({ ref: entry.path, reason: "worktree has uncommitted changes" });
			removable.delete(entry.branch);
			continue;
		}
		if ((await git(cwd, ["worktree", "remove", entry.path])) === null) {
			report.skipped.push({ ref: entry.path, reason: "git worktree remove failed" });
			removable.delete(entry.branch);
			continue;
		}
		entry.branch = null;
		report.worktreesRemoved.push(entry.path);
	}
}

/** Delete removable branches no longer checked out in any worktree. */
async function deleteMergedBranches(
	cwd: string,
	worktrees: WorktreeEntry[],
	removable: Set<string>,
	report: CleanupReport,
): Promise<void> {
	const checkedOut = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null));
	for (const branch of removable) {
		if (checkedOut.has(branch)) continue;
		if ((await git(cwd, ["branch", "-D", branch])) === null) continue;
		report.branchesDeleted.push(branch);
	}
}

/** Format a cleanup report as a terse human-readable string. */
export function formatCleanupReport(report: CleanupReport): string {
	const lines: string[] = [];
	if (report.worktreesRemoved.length > 0) {
		lines.push(`Worktrees removed: ${report.worktreesRemoved.join(", ")}`);
	}
	if (report.branchesDeleted.length > 0) {
		lines.push(`Branches deleted: ${report.branchesDeleted.join(", ")}`);
	}
	for (const skip of report.skipped) {
		lines.push(`Skipped ${skip.ref}: ${skip.reason}`);
	}
	if (report.remotesPruned) {
		lines.push("Remote-tracking refs pruned.");
	}
	return lines.length > 0 ? lines.join("\n") : "Local cleanup: nothing to remove.";
}
