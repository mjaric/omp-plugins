/**
 * Embedding endpoint chain (spec §5).
 *
 * Ordered list of OpenAI-compatible `/embeddings` endpoints; first-healthy
 * wins, a failed primary gets a cooldown before retry. `fetch` is the single
 * network touchpoint and is injectable for tests. The AbortSignal from the
 * caller is forwarded to every fetch.
 */

import type { EndpointConfig } from "./types";

/** A successful embedding result, tagged with the model that produced it. */
export interface EmbedResult {
	vector: number[];
	model: string;
}

/** Health snapshot for one endpoint (used by `smem_status`). */
export interface EmbedderHealth {
	name: string;
	model: string;
	healthy: boolean;
	cooldownUntil: number | null;
	lastError: string | null;
}

/** The subset of `fetch`/`Response` the chain depends on (injectable for tests). */
export type FetchLike = (url: string, init: EmbedRequestInit) => Promise<EmbedResponse>;

export interface EmbedRequestInit {
	method: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal | null;
}

export interface EmbedResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

/** Epoch-millis clock, injectable for deterministic tests. */
export type Clock = () => number;

/** Ordered embedding endpoint chain with first-healthy-wins + failure cooldown. */
export class EmbeddingChain {
	private readonly failAt = new Map<string, number>();
	private readonly lastError = new Map<string, string | null>();
	private readonly endpoints: EndpointConfig[];
	private readonly fetchImpl: FetchLike;
	private readonly cooldownMs: number;
	private readonly now: Clock;

	constructor(
		endpoints: EndpointConfig[],
		fetchImpl: FetchLike = defaultFetch,
		cooldownMs: number = 30_000,
		now: Clock = Date.now,
	) {
		this.endpoints = endpoints;
		this.fetchImpl = fetchImpl;
		this.cooldownMs = cooldownMs;
		this.now = now;
	}

	/** Embed `text` via the first healthy endpoint; null when all fail or none configured. */
	async embed(text: string, signal?: AbortSignal): Promise<EmbedResult | null> {
		for (const endpoint of this.endpoints) {
			if (this.inCooldown(endpoint.name)) continue;
			// Sequential short-circuit: the first healthy endpoint wins; parallel
			// fan-out would waste the fallback endpoint on every success.
			// eslint-disable-next-line no-await-in-loop
			const result = await this.tryEndpoint(endpoint, text, signal);
			if (result) return result;
		}
		return null;
	}

	/** Health snapshot for every configured endpoint. */
	health(): EmbedderHealth[] {
		return this.endpoints.map(endpoint => {
			const cooldownUntil = this.cooldownUntilFor(endpoint.name);
			return {
				name: endpoint.name,
				model: endpoint.model,
				healthy: cooldownUntil === null,
				cooldownUntil,
				lastError: this.lastError.get(endpoint.name) ?? null,
			};
		});
	}

	/** Attempt one endpoint; on success clear its failure state, on failure cool it down. */
	private async tryEndpoint(endpoint: EndpointConfig, text: string, signal?: AbortSignal): Promise<EmbedResult | null> {
		try {
			const vector = await this.postEmbeddings(endpoint, text, signal);
			this.failAt.delete(endpoint.name);
			this.lastError.delete(endpoint.name);
			return { vector, model: endpoint.model };
		} catch (err) {
			this.recordFailure(endpoint.name, err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	/** POST `/embeddings` and extract the first embedding vector. */
	private async postEmbeddings(endpoint: EndpointConfig, text: string, signal?: AbortSignal): Promise<number[]> {
		const url = joinEmbeddings(endpoint.baseUrl);
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (endpoint.apiKey) headers["authorization"] = `Bearer ${endpoint.apiKey}`;
		const body = JSON.stringify({ model: endpoint.model, input: [text] });
		const init: EmbedRequestInit = { method: "POST", headers, body };
		if (signal) init.signal = signal;
		const res = await this.fetchImpl(url, init);
		return parseEmbedding(await res.json(), res);
	}

	private recordFailure(name: string, message: string): void {
		this.failAt.set(name, this.now());
		this.lastError.set(name, message);
	}

	private inCooldown(name: string): boolean {
		return this.cooldownUntilFor(name) !== null;
	}

	private cooldownUntilFor(name: string): number | null {
		const fail = this.failAt.get(name);
		if (fail === undefined) return null;
		const until = fail + this.cooldownMs;
		return until > this.now() ? until : null;
	}
}

/** Build the `/embeddings` URL from a base (tolerant of trailing slashes). */
export function joinEmbeddings(baseUrl: string): string {
	const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	return `${trimmed}/embeddings`;
}

/** Extract the first embedding vector from an OpenAI-compatible response. */
export function parseEmbedding(payload: unknown, res: EmbedResponse): number[] {
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data) || data.length === 0) {
		throw new Error(`embeddings endpoint returned no data (status ${res.status})`);
	}
	const first = data[0] as { embedding?: unknown };
	if (!first || !Array.isArray(first.embedding) || first.embedding.length === 0) {
		throw new Error(`embeddings endpoint returned an empty vector (status ${res.status})`);
	}
	return first.embedding as number[];
}

/** Default fetch adapter bridging the global `fetch` to {@link FetchLike}. */
async function defaultFetch(url: string, init: EmbedRequestInit): Promise<EmbedResponse> {
	const res = await fetch(url, init);
	return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() };
}
