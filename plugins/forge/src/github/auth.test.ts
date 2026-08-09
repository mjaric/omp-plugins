import { describe, expect, it, mock, beforeEach } from "bun:test";
import { resolveGhToken } from "./auth";

// Mock fs reads — we don't want tests depending on the real hosts.yml
const mockReadFileSync = mock((_path: string, _encoding?: string): string => "");
// Mock gh CLI spawn
const mockSpawnSync = mock((): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } => ({
	exitCode: 1,
	stdout: new Uint8Array(),
	stderr: new Uint8Array(),
}));
// Mock env
const mockEnv: Record<string, string | undefined> = {};

mock.module("node:fs", () => ({
	readFileSync: (path: string, encoding?: string) => mockReadFileSync(path, encoding),
}));

// Stub Bun.spawnSync so gh auth token never hits the real CLI in tests
Bun.spawnSync = mockSpawnSync as unknown as typeof Bun.spawnSync;

const originalEnv = process.env;

beforeEach(() => {
	mockReadFileSync.mockImplementation(() => "");
	mockSpawnSync.mockImplementation(() => ({
		exitCode: 1,
		stdout: new Uint8Array(),
		stderr: new Uint8Array(),
	}));
	for (const key of Object.keys(mockEnv)) {
		delete mockEnv[key];
	}
});

function setEnv(entries: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(entries)) {
		mockEnv[key] = value;
	}
	Object.defineProperty(process, "env", { value: mockEnv, configurable: true });
}

function restoreEnv(): void {
	Object.defineProperty(process, "env", { value: originalEnv, configurable: true });
}

describe("resolveGhToken", () => {
	it("returns token from hosts.yml when present", () => {
		mockReadFileSync.mockImplementation(() =>
			"github.com:\n    oauth_token: gho_testtoken123\n    user: mjaric\n    git_protocol: https\n",
		);
		const result = resolveGhToken();
		expect(result?.token).toBe("gho_testtoken123");
		expect(result?.source).toBe("hosts-yml");
	});

	it("falls back to gh auth token when hosts.yml has no token", () => {
		mockReadFileSync.mockImplementation(() => "github.com:\n    user: test\n");
		mockSpawnSync.mockImplementation(() => ({
			exitCode: 0,
			stdout: new TextEncoder().encode("gho_from_cli\n"),
			stderr: new Uint8Array(),
		}));
		setEnv({});
		const result = resolveGhToken();
		expect(result?.token).toBe("gho_from_cli");
		expect(result?.source).toBe("gh-cli");
		restoreEnv();
	});

	it("falls back to GH_TOKEN env when hosts.yml and gh-cli have no token", () => {
		mockReadFileSync.mockImplementation(() => "github.com:\n    user: test\n");
		setEnv({ GH_TOKEN: "env_gh_token" });
		const result = resolveGhToken();
		expect(result?.token).toBe("env_gh_token");
		expect(result?.source).toBe("env");
		restoreEnv();
	});

	it("falls back to GITHUB_TOKEN env", () => {
		mockReadFileSync.mockImplementation(() => "");
		setEnv({ GITHUB_TOKEN: "env_github_token" });
		const result = resolveGhToken();
		expect(result?.token).toBe("env_github_token");
		expect(result?.source).toBe("env");
		restoreEnv();
	});

	it("returns null when no token found anywhere", () => {
		mockReadFileSync.mockImplementation(() => "");
		setEnv({});
		const result = resolveGhToken();
		expect(result).toBeNull();
		restoreEnv();
	});

	it("prefers hosts.yml over env", () => {
		mockReadFileSync.mockImplementation(() =>
			"github.com:\n    oauth_token: gho_from_hosts\n",
		);
		setEnv({ GH_TOKEN: "from_env" });
		const result = resolveGhToken();
		expect(result?.token).toBe("gho_from_hosts");
		expect(result?.source).toBe("hosts-yml");
		restoreEnv();
	});

	it("handles missing hosts.yml gracefully", () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT: no such file");
		});
		setEnv({ GH_TOKEN: "fallback_token" });
		const result = resolveGhToken();
		expect(result?.token).toBe("fallback_token");
		expect(result?.source).toBe("env");
		restoreEnv();
	});
});
