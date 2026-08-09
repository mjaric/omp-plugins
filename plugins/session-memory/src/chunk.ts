/**
 * Chunking — message-boundary chunks with size-cap splitting (spec §6.1).
 *
 * Each indexed message becomes one or more chunks: first split at sentence
 * boundaries, then size-capped at ~`maxChunkTokens` (char/4 estimate). Only
 * user + assistant text is indexed; empty/punctuation noise is filtered.
 */

import type { ChunkInput, IndexedRole } from "./types";

/** Rough token estimate: ~4 chars/token (spec §6.1). */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Extract indexable text from a chat message.
 * Returns `{ role, text }` for user/assistant messages with real text, else null.
 */
export function extractMessageText(message: unknown): { role: IndexedRole; text: string } | null {
	if (typeof message !== "object" || message === null) return null;
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "user" && m.role !== "assistant") return null;
	const text = flattenContent(m.content).trim();
	return isIndexableText(text) ? { role: m.role, text } : null;
}

/** Split one message into size-capped chunks (sentence-aware). */
export function chunkMessage(input: ChunkInput, maxTokens: number): ChunkInput[] {
	const pieces = splitBySize(input.text, maxTokens);
	return pieces.map(text => ({
		sessionId: input.sessionId,
		role: input.role,
		turnNo: input.turnNo,
		text,
		tokenEstimate: estimateTokens(text),
	}));
}

/** Flatten a message `content` (string or block array) into plain text. */
function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => isTextBlock(b))
		.map(b => b.text)
		.join("\n");
}

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
	return typeof b === "object" && b !== null
		&& (b as { type?: unknown }).type === "text"
		&& typeof (b as { text?: unknown }).text === "string";
}

/** True when text carries real content (non-empty, has a letter or digit). */
function isIndexableText(text: string): boolean {
	if (text.length < 2) return false;
	return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Sentence-aware size-capped split.
 * Splits at sentence boundaries, accumulating into chunks ≤ maxTokens; any
 * single sentence longer than the cap is hard-split on the cap boundary.
 */
export function splitBySize(text: string, maxTokens: number): string[] {
	const maxChars = Math.max(1, maxTokens) * 4;
	const sentences = splitSentences(text);
	if (sentences.length === 0) return [];
	const chunks: string[] = [];
	let buffer = "";
	for (const sentence of sentences) {
		if (sentence.length > maxChars) {
			flushInto(chunks, buffer);
			buffer = "";
			hardSplit(sentence, maxChars, chunks);
			continue;
		}
		const candidate = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
		if (candidate.length > maxChars && buffer.length > 0) {
			flushInto(chunks, buffer);
			buffer = sentence;
		} else {
			buffer = candidate;
		}
	}
	flushInto(chunks, buffer);
	return chunks;
}

/** Split text into sentence-ish units on terminators and newlines. */
function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?。！？])\s+|\n+/u)
		.map(s => s.trim())
		.filter(s => s.length > 0);
}

/** Push a non-empty buffer onto the chunks list. */
function flushInto(chunks: string[], buffer: string): void {
	if (buffer.trim().length > 0) chunks.push(buffer.trim());
}

/** Hard-split an oversized sentence into fixed-width pieces. */
function hardSplit(sentence: string, maxChars: number, chunks: string[]): void {
	for (let i = 0; i < sentence.length; i += maxChars) {
		const piece = sentence.slice(i, i + maxChars).trim();
		if (piece.length > 0) chunks.push(piece);
	}
}
