/**
 * Configuration model — endpoint chain (spec §7), profile, rerank settings.
 *
 * Config is persisted as JSON in the store `meta` table under key "config".
 * The `FILEGRAPH_ENDPOINTS` env var (JSON array) overrides stored endpoints
 * when present. Rerank is OFF by default; no HTTP calls are made this wave.
 */

import type { EndpointConfig, FileGraphConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import type { GraphStore } from "../store/store";

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

/** Merge env endpoint override into a config (env wins when non-empty). */
export function applyEnv(config: FileGraphConfig, env: Record<string, string | undefined>): FileGraphConfig {
	const endpoints = parseEndpoints(env["FILEGRAPH_ENDPOINTS"]);
	return endpoints.length > 0 ? { ...config, endpoints } : config;
}

/** Load config from the store, applying env overrides. */
export function loadConfig(store: GraphStore): FileGraphConfig {
	const json = store.getMeta("config");
	return applyEnv(deserializeConfig(json), globalEnv());
}

/** Persist config to the store meta table. */
export function saveConfig(store: GraphStore, config: FileGraphConfig): void {
	store.setMeta("config", JSON.stringify(config));
}

/** Deserialize stored JSON into a fully-populated config (defaults fill gaps). */
export function deserializeConfig(json: string | null): FileGraphConfig {
	if (!json) return { ...DEFAULT_CONFIG };
	try {
		return mergeWithDefaults(JSON.parse(json));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Set one config key from a JSON value string.
 * Throws on unknown keys or invalid JSON so the caller surfaces the error.
 */
export function setConfigKey(config: FileGraphConfig, key: string, jsonValue: string): FileGraphConfig {
	const parsed: unknown = JSON.parse(jsonValue);
	switch (key) {
		case "profile":
			return setProfile(config, parsed);
		case "namespaces":
			return { ...config, namespaces: toStringArray(parsed) };
		case "rerankEnabled":
			return { ...config, rerankEnabled: Boolean(parsed) };
		case "rerankTopN":
			return { ...config, rerankTopN: toPositiveNumber(parsed) };
		case "endpoints":
			if (!Array.isArray(parsed)) throw new Error("endpoints must be a JSON array");
			return { ...config, endpoints: parsed.filter(isValidEndpoint) };
		default:
			throw new Error(`Unknown config key "${key}". Valid keys: profile, namespaces, rerankEnabled, rerankTopN, endpoints`);
	}
}

/** Format config for human display (`/fg config`). */
export function formatConfig(config: FileGraphConfig): string {
	const ns = config.namespaces.length > 0 ? config.namespaces.join(", ") : "(none)";
	const rerank = config.rerankEnabled ? `on (top ${config.rerankTopN})` : "off";
	const eps = config.endpoints.length > 0
		? config.endpoints.map(e => `${e.name}@${e.model}`).join(", ")
		: "(none)";
	return `profile: ${config.profile}\nnamespaces: ${ns}\nrerank: ${rerank}\nendpoints: ${eps}`;
}

// -- helpers ----------------------------------------------------------------

function setProfile(config: FileGraphConfig, parsed: unknown): FileGraphConfig {
	if (parsed !== "generic" && parsed !== "zksrc") {
		throw new Error("profile must be \"generic\" or \"zksrc\"");
	}
	return { ...config, profile: parsed };
}

function mergeWithDefaults(parsed: unknown): FileGraphConfig {
	if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_CONFIG };
	const p = parsed as Record<string, unknown>;
	return {
		profile: p["profile"] === "zksrc" ? "zksrc" : "generic",
		namespaces: toStringArray(p["namespaces"]),
		rerankEnabled: p["rerankEnabled"] === true,
		rerankTopN: typeof p["rerankTopN"] === "number" ? p["rerankTopN"] : 12,
		endpoints: Array.isArray(p["endpoints"]) ? p["endpoints"].filter(isValidEndpoint) : [],
	};
}

function isValidEndpoint(e: unknown): e is EndpointConfig {
	if (typeof e !== "object" || e === null) return false;
	const obj = e as Record<string, unknown>;
	return (
		typeof obj["name"] === "string" &&
		typeof obj["baseUrl"] === "string" &&
		typeof obj["model"] === "string"
	);
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function toPositiveNumber(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 12;
}

function globalEnv(): Record<string, string | undefined> {
	return process.env as Record<string, string | undefined>;
}
