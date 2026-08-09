/**
 * Configuration model — endpoint chain (spec §5), recall mode, and tuning knobs.
 *
 * Config is persisted as JSON in the store `meta` table under key "config". The
 * `SMEM_ENDPOINTS` env var (JSON array) overrides stored endpoints when present.
 * Pure logic only; the store owns read/write of the `meta` row.
 */

import type { EndpointConfig, RecallMode, SmemConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

/** Parse a JSON string into an endpoint list, filtering invalid entries. */
export function parseEndpoints(value: string | undefined): EndpointConfig[] {
	if (!value || value.trim().length === 0) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isValidEndpoint);
	} catch {
		return [];
	}
}

/** Merge the `SMEM_ENDPOINTS` env override into a config (env wins when set). */
export function applyEnv(config: SmemConfig, env: Record<string, string | undefined>): SmemConfig {
	const raw = env["SMEM_ENDPOINTS"];
	if (raw === undefined) return config;
	const endpoints = parseEndpoints(raw);
	return { ...config, endpoints };
}

/** Deserialize stored JSON into a fully-populated config (defaults fill gaps). */
export function deserializeConfig(json: string | null): SmemConfig {
	if (!json) return { ...DEFAULT_CONFIG };
	try {
		return mergeWithDefaults(JSON.parse(json));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Serialize a config for the `meta` table. */
export function serializeConfig(config: SmemConfig): string {
	return JSON.stringify(config);
}

/**
 * Set one config key from a JSON value string.
 * Throws on unknown keys or invalid JSON so the caller surfaces the error.
 */
export function setConfigKey(config: SmemConfig, key: string, jsonValue: string): SmemConfig {
	switch (key) {
		case "mode":
			return { ...config, mode: parseMode(jsonValue) };
		case "endpoints":
			return { ...config, endpoints: parseEndpoints(jsonValue) };
		case "topK":
			return { ...config, topK: parsePositiveNumber(jsonValue) };
		case "compactedBoost":
			return { ...config, compactedBoost: parseNonNegativeNumber(jsonValue) };
		case "maxChunkTokens":
			return { ...config, maxChunkTokens: parsePositiveNumber(jsonValue) };
		case "cooldownMs":
			return { ...config, cooldownMs: parseNonNegativeNumber(jsonValue) };
		default:
			throw new Error(`Unknown config key "${key}". Valid: mode, endpoints, topK, compactedBoost, maxChunkTokens, cooldownMs.`);
	}
}

/** Format config for human display (`/smem config`). */
export function formatConfig(config: SmemConfig): string {
	const eps = config.endpoints.length === 0
		? "(none — set via SMEM_ENDPOINTS or /smem config endpoints)"
		: config.endpoints.map(e => `  - ${e.name}: ${e.baseUrl} [${e.model}]`).join("\n");
	return [
		`mode: ${config.mode}`,
		`topK: ${config.topK}`,
		`compactedBoost: ${config.compactedBoost}`,
		`maxChunkTokens: ${config.maxChunkTokens}`,
		`cooldownMs: ${config.cooldownMs}`,
		`endpoints:`,
		eps,
	].join("\n");
}

/** Merge a parsed object into a fully-populated config. */
function mergeWithDefaults(parsed: unknown): SmemConfig {
	if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_CONFIG };
	const p = parsed as Record<string, unknown>;
	return {
		mode: isMode(p["mode"]) ? p["mode"] : DEFAULT_CONFIG.mode,
		endpoints: Array.isArray(p["endpoints"]) ? p["endpoints"].filter(isValidEndpoint) : [],
		topK: toPositiveNumber(p["topK"]) ?? DEFAULT_CONFIG.topK,
		compactedBoost: toNonNegativeNumber(p["compactedBoost"]) ?? DEFAULT_CONFIG.compactedBoost,
		maxChunkTokens: toPositiveNumber(p["maxChunkTokens"]) ?? DEFAULT_CONFIG.maxChunkTokens,
		cooldownMs: toNonNegativeNumber(p["cooldownMs"]) ?? DEFAULT_CONFIG.cooldownMs,
	};
}

/** Type guard for a single valid endpoint entry. */
function isValidEndpoint(e: unknown): e is EndpointConfig {
	if (typeof e !== "object" || e === null) return false;
	const v = e as Record<string, unknown>;
	return typeof v["name"] === "string"
		&& typeof v["baseUrl"] === "string"
		&& typeof v["model"] === "string"
		&& v["name"].length > 0
		&& v["baseUrl"].length > 0
		&& v["model"].length > 0;
}

function isMode(value: unknown): value is RecallMode {
	return value === "off" || value === "naive" || value === "prefix-safe";
}

function parseMode(jsonValue: string): RecallMode {
	const v: unknown = JSON.parse(jsonValue);
	if (!isMode(v)) throw new Error(`Invalid mode "${jsonValue}". Valid: off, naive, prefix-safe.`);
	return v;
}

function parsePositiveNumber(jsonValue: string): number {
	const n = toPositiveNumber(JSON.parse(jsonValue));
	if (n === null) throw new Error(`Expected a positive number, got: ${jsonValue}`);
	return n;
}

function parseNonNegativeNumber(jsonValue: string): number {
	const n = toNonNegativeNumber(JSON.parse(jsonValue));
	if (n === null) throw new Error(`Expected a non-negative number, got: ${jsonValue}`);
	return n;
}

function toPositiveNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Minimal store surface for config persistence (avoids importing MemStore). */
export interface MetaStore {
	getMeta(key: string): string | null;
	setMeta(key: string, value: string): void;
}

/** Load config from the store meta table, applying env overrides. */
export function loadConfig(store: MetaStore, env: Record<string, string | undefined>): SmemConfig {
	const config = deserializeConfig(store.getMeta("config"));
	return applyEnv(config, env);
}

/** Persist config to the store meta table. */
export function saveConfig(store: MetaStore, config: SmemConfig): void {
	store.setMeta("config", serializeConfig(config));
}

function toNonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
