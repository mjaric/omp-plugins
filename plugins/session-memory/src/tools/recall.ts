/**
 * smem_recall — explicit, agent-driven recall (spec §9).
 *
 * Embeds the query, runs prefix-safe dedup against the current session context,
 * and returns the new chunks (with attribution) + structured package details.
 *
 * Schemas are authored with ArkType (omptype) and emitted as JSON Schema at the
 * tool boundary — the same wire shape file-graph's TypeBox tools produce.
 */

import { type } from "@oh-my-pi/omptype";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SmemRuntime } from "../runtime";
import { branchMessages, ensureStore, errorResult, notInitialisedResult, prepareRecall, textResult } from "../runtime";
import { formatRecallMessage } from "../inject";
import { telemetryPath } from "../workspace";
import type { RecallPackage } from "../types";

const schema = type({
	query: type("string").describe("the prompt or question to recall earlier session material for"),
});

type RecallParams = (typeof schema)["infer"];

/** Register the smem_recall tool. */
export function registerRecallTool(pi: ExtensionAPI, rt: SmemRuntime): void {
	pi.registerTool({
		name: "smem_recall",
		label: "Session Memory Recall",
		description:
			"Retrieve relevant earlier user/assistant material from this session that is NOT already in context. Returns new chunks with [turn N, role] attribution and a reference block for already-covered items.",
		parameters: schema.toJsonSchema(),
		approval: "read",
		async execute(_id, raw, signal, _onUpdate, ctx) {
			const p = raw as RecallParams;
			const store = ensureStore(rt, ctx.cwd);
			if (!store) return notInitialisedResult();
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return errorResult("No active session id; recall is unavailable.", { error: "no_session" });
			const contextMessages = branchMessages(ctx.sessionManager.getBranch());
			const pkg = await prepareRecall(rt, sessionId, p.query, contextMessages, signal);
			return textResult(describePackage(pkg), { package: pkg, storePath: store.path, telemetryPath: telemetryPath(ctx.cwd) });
		},
	});
}

/** Human-readable summary of a recall package (mirrors the injected block). */
function describePackage(pkg: RecallPackage): string {
	if (pkg.chunks.length === 0 && pkg.references.length === 0) {
		return `No new session-memory recall (mode: ${pkg.mode}, ${pkg.recallMs}ms).`;
	}
	return formatRecallMessage(pkg);
}
