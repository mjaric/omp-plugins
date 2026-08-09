import { describe, expect, it } from "bun:test";
import {
	applyEnv,
	deserializeConfig,
	formatConfig,
	parseEndpoints,
	setConfigKey,
} from "./config";
import { DEFAULT_CONFIG } from "../types";

describe("parseEndpoints", () => {
	it("parses a valid JSON endpoint array", () => {
		const json = '[{"name":"local","baseUrl":"http://localhost:11434","model":"qwen3:4b"}]';
		const eps = parseEndpoints(json);
		expect(eps).toHaveLength(1);
		expect(eps[0]!.name).toBe("local");
		expect(eps[0]!.model).toBe("qwen3:4b");
	});

	it("returns empty for invalid JSON", () => {
		expect(parseEndpoints("not json")).toEqual([]);
	});

	it("returns empty for undefined", () => {
		expect(parseEndpoints(undefined)).toEqual([]);
	});

	it("filters out entries missing required fields", () => {
		const json = '[{"name":"ok","baseUrl":"x","model":"y"},{"name":"bad"}]';
		expect(parseEndpoints(json)).toHaveLength(1);
	});
});

describe("applyEnv", () => {
	it("overrides endpoints when FILEGRAPH_ENDPOINTS is set", () => {
		const cfg = { ...DEFAULT_CONFIG, endpoints: [{ name: "old", baseUrl: "x", model: "y" }] };
		const result = applyEnv(cfg, { FILEGRAPH_ENDPOINTS: '[{"name":"new","baseUrl":"z","model":"w"}]' });
		expect(result.endpoints).toHaveLength(1);
		expect(result.endpoints[0]!.name).toBe("new");
	});

	it("keeps stored endpoints when env is absent", () => {
		const cfg = { ...DEFAULT_CONFIG, endpoints: [{ name: "old", baseUrl: "x", model: "y" }] };
		const result = applyEnv(cfg, {});
		expect(result.endpoints[0]!.name).toBe("old");
	});
});

describe("setConfigKey", () => {
	it("sets profile", () => {
		const result = setConfigKey({ ...DEFAULT_CONFIG }, "profile", '"zksrc"');
		expect(result.profile).toBe("zksrc");
	});

	it("rejects invalid profile", () => {
		expect(() => setConfigKey({ ...DEFAULT_CONFIG }, "profile", '"invalid"')).toThrow();
	});

	it("sets namespaces", () => {
		const result = setConfigKey({ ...DEFAULT_CONFIG }, "namespaces", '["C","RQ"]');
		expect(result.namespaces).toEqual(["C", "RQ"]);
	});

	it("sets rerankEnabled", () => {
		const result = setConfigKey({ ...DEFAULT_CONFIG }, "rerankEnabled", "true");
		expect(result.rerankEnabled).toBe(true);
	});

	it("throws on unknown key", () => {
		expect(() => setConfigKey({ ...DEFAULT_CONFIG }, "bogus", "1")).toThrow();
	});

	it("throws on invalid JSON", () => {
		expect(() => setConfigKey({ ...DEFAULT_CONFIG }, "profile", "not json")).toThrow();
	});
});

describe("deserializeConfig", () => {
	it("returns defaults for null", () => {
		expect(deserializeConfig(null)).toEqual(DEFAULT_CONFIG);
	});

	it("round-trips through serialization", () => {
		const cfg = setConfigKey({ ...DEFAULT_CONFIG }, "profile", '"zksrc"');
		const json = JSON.stringify(cfg);
		expect(deserializeConfig(json).profile).toBe("zksrc");
	});

	it("falls back on malformed JSON", () => {
		expect(deserializeConfig("{broken")).toEqual(DEFAULT_CONFIG);
	});
});

describe("formatConfig", () => {
	it("shows rerank off by default", () => {
		const text = formatConfig(DEFAULT_CONFIG);
		expect(text).toContain("rerank: off");
	});

	it("shows rerank on when enabled", () => {
		const text = formatConfig({ ...DEFAULT_CONFIG, rerankEnabled: true, rerankTopN: 5 });
		expect(text).toContain("rerank: on (top 5)");
	});
});
