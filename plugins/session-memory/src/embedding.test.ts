import { describe, expect, it } from "bun:test";
import { EmbeddingChain, joinEmbeddings, parseEmbedding } from "./embedding";
import type { EmbedRequestInit, EmbedResponse } from "./embedding";
import type { EndpointConfig } from "./types";

function endpoint(name: string, model: string): EndpointConfig {
	return { name, baseUrl: `http://${name}.test`, model };
}

function jsonResponse(status: number, payload: unknown): EmbedResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => payload,
		text: async () => JSON.stringify(payload),
	};
}

describe("joinEmbeddings", () => {
	it("appends /embeddings tolerating trailing slashes", () => {
		expect(joinEmbeddings("http://a.test")).toBe("http://a.test/embeddings");
		expect(joinEmbeddings("http://a.test/")).toBe("http://a.test/embeddings");
	});
});

describe("parseEmbedding", () => {
	it("extracts the first vector", () => {
		const res = jsonResponse(200, { data: [{ embedding: [0.1, 0.2] }] });
		expect(parseEmbedding({ data: [{ embedding: [0.1, 0.2] }] }, res)).toEqual([0.1, 0.2]);
	});

	it("throws on empty data or empty vector", () => {
		const res = jsonResponse(200, {});
		expect(() => parseEmbedding({ data: [] }, res)).toThrow(/no data/);
		expect(() => parseEmbedding({ data: [{ embedding: [] }] }, res)).toThrow(/empty vector/);
	});
});

describe("EmbeddingChain", () => {
	it("returns the first healthy endpoint's vector tagged with its model", async () => {
		const calls: string[] = [];
		const chain = new EmbeddingChain(
			[endpoint("primary", "model-a"), endpoint("fallback", "model-b")],
			async url => {
				calls.push(url);
				return jsonResponse(200, { data: [{ embedding: [1, 0] }] });
			},
		);
		const result = await chain.embed("text");
		expect(result?.model).toBe("model-a");
		expect(calls).toEqual(["http://primary.test/embeddings"]);
	});

	it("falls back to the next endpoint when the primary fails", async () => {
		const chain = new EmbeddingChain(
			[endpoint("primary", "model-a"), endpoint("fallback", "model-b")],
			async url => {
				if (url.includes("primary")) throw new Error("connection refused");
				return jsonResponse(200, { data: [{ embedding: [0, 1] }] });
			},
		);
		const result = await chain.embed("text");
		expect(result?.model).toBe("model-b");
		expect(result?.vector).toEqual([0, 1]);
	});

	it("returns null when every endpoint fails or none is configured", async () => {
		const failing = new EmbeddingChain([endpoint("a", "m")], async () => {
			throw new Error("boom");
		});
		expect(await failing.embed("text")).toBeNull();
		const empty = new EmbeddingChain([]);
		expect(await empty.embed("text")).toBeNull();
	});

	it("cools down a failed endpoint and retries after the cooldown", async () => {
		let now = 1000;
		let attempts = 0;
		const chain = new EmbeddingChain(
			[endpoint("primary", "model-a"), endpoint("fallback", "model-b")],
			async url => {
				attempts++;
				if (url.includes("primary") && attempts <= 1) throw new Error("down");
				return jsonResponse(200, { data: [{ embedding: [1] }] });
			},
			5000,
			() => now,
		);
		const first = await chain.embed("text");
		expect(first?.model).toBe("model-b");

		// Still in cooldown — primary skipped without a network attempt.
		const before = attempts;
		const second = await chain.embed("text");
		expect(second?.model).toBe("model-b");
		expect(attempts).toBe(before + 1);

		// After the cooldown elapses, primary is retried and wins again.
		now = 1000 + 5001;
		const third = await chain.embed("text");
		expect(third?.model).toBe("model-a");
	});

	it("clears failure state after a successful retry", async () => {
		let now = 0;
		let fail = true;
		const chain = new EmbeddingChain(
			[endpoint("primary", "model-a")],
			async () => {
				if (fail) throw new Error("down");
				return jsonResponse(200, { data: [{ embedding: [1] }] });
			},
			100,
			() => now,
		);
		expect(await chain.embed("x")).toBeNull();
		now = 200;
		fail = false;
		expect((await chain.embed("x"))?.model).toBe("model-a");
		// Immediately eligible again — no cooldown after success.
		expect((await chain.embed("y"))?.model).toBe("model-a");
	});

	it("reports health with cooldown and last error", async () => {
		const chain = new EmbeddingChain(
			[endpoint("primary", "model-a")],
			async () => {
				throw new Error("refused");
			},
			5000,
			() => 100,
		);
		await chain.embed("x");
		const health = chain.health();
		expect(health[0]?.healthy).toBe(false);
		expect(health[0]?.lastError).toBe("refused");
		expect(health[0]?.cooldownUntil).toBe(5100);
	});

	it("forwards the abort signal to fetch", async () => {
		let seen: AbortSignal | undefined | null;
		const chain = new EmbeddingChain([endpoint("a", "m")], async (_url, init) => {
			seen = init.signal;
			return jsonResponse(200, { data: [{ embedding: [1] }] });
		});
		const controller = new AbortController();
		await chain.embed("x", controller.signal);
		expect(seen).toBe(controller.signal);
	});

	it("sends a bearer header only when an api key is configured", async () => {
		const headers: Record<string, string>[] = [];
		const capture = async (_url: string, init: EmbedRequestInit): Promise<EmbedResponse> => {
			headers.push(init.headers);
			return jsonResponse(200, { data: [{ embedding: [1] }] });
		};
		const keyed = new EmbeddingChain(
			[{ name: "k", baseUrl: "http://k.test", model: "m", apiKey: "secret" }],
			capture,
		);
		await keyed.embed("x");
		expect(headers[0]?.["authorization"]).toBe("Bearer secret");
		const keyless = new EmbeddingChain([endpoint("nk", "m")], capture);
		await keyless.embed("x");
		expect(headers[1]?.["authorization"]).toBeUndefined();
	});
});
