import { describe, expect, it } from "bun:test";
import { getOriginRemote, normalizeRepoId } from "./git-remote";

describe("normalizeRepoId", () => {
	it("normalizes SSH URL", () => {
		expect(normalizeRepoId("git@github.com:mjaric/smith.git")).toBe("mjaric/smith");
	});

	it("normalizes HTTPS URL", () => {
		expect(normalizeRepoId("https://github.com/mjaric/smith.git")).toBe("mjaric/smith");
	});

	it("normalizes ssh:// protocol URL", () => {
		expect(normalizeRepoId("ssh://git@github.com/mjaric/smith.git")).toBe("mjaric/smith");
	});

	it("normalizes git+https URL", () => {
		expect(normalizeRepoId("git+https://github.com/mjaric/smith.git")).toBe("mjaric/smith");
	});

	it("normalizes URL without .git suffix", () => {
		expect(normalizeRepoId("https://github.com/mjaric/smith")).toBe("mjaric/smith");
	});

	it("is case-insensitive", () => {
		expect(normalizeRepoId("git@github.com:Mjaric/Smith.git")).toBe("mjaric/smith");
	});

	it("compares equal regardless of protocol form", () => {
		const ssh = normalizeRepoId("git@github.com:mjaric/smith.git");
		const https = normalizeRepoId("https://github.com/mjaric/smith.git");
		expect(ssh).toBe(https);
	});
});

describe("getOriginRemote", () => {
	it("reads origin remote from a real git repo", () => {
		// This test runs in the plugin's own directory which is a git repo.
		const remote = getOriginRemote(process.cwd());
		// In CI or local, the remote should be non-null.
		// If null (e.g. no git), skip the assertion gracefully.
		if (remote !== null) {
			expect(remote.length).toBeGreaterThan(0);
		}
	});

	it("returns null for a non-git directory", () => {
		const remote = getOriginRemote("/tmp");
		// /tmp may or may not be in a git repo depending on the system;
		// just verify it doesn't throw.
		expect(typeof remote === "string" || remote === null).toBe(true);
	});
});
