# Plugin spec: `session-memory` — live session index with prefix-safe recall

Date: 2026-08-05 · Status: approved for design-complete; implementation AFTER
`file-graph` lands · Owner repo: `omp-plugins`

## 1. Purpose

Index every user message and assistant response **in flight** during a
session. On the next prompt, retrieve relevant earlier material but inject
ONLY what is not already in context:

- keep the context **prefix byte-identical** (provider KV/prompt cache keeps hitting);
- already-present material is replaced by a short reference block
  ("already covered: a, b, c" — titles only, no content);
- genuinely new material is appended **at the tail**.

Success is **measured**, not assumed: cache-hit rate + injected-bytes +
answer-quality comparison vs naive full re-injection. The attention-layer
question (reference-then-detail effectiveness) is an experiment enabled by
this plugin's telemetry, deferred past v1.

Relationship to omp's memory backends (`local`/`hindsight`/`mnemopi`): this
plugin is a **standalone extension** that never touches `memory.backend`.
Overlap is accepted; differentiation is the prefix-safe injection policy +
cache telemetry.

## 2. Repo placement and conventions (binding)

Same binding contract as `file-graph` spec §2 (package at
`plugins/session-memory/`, marketplace entry, Bun + bun:sqlite, ArkType,
`smem_*` tool names, managed timers, best-effort startup, hard limits).

## 3. Verified omp API facts (do not re-derive)

| Need | Verified mechanism |
|---|---|
| Message capture | `pi.on("message_end", …)` fires for user/assistant/toolResult messages; content is in the event. Assistant messages carry `usage` with `cacheRead`/`cacheWrite`. |
| Compaction signal | `session_compact` / `auto_compaction_end` events mark compacted ranges — those chunks become recall-first candidates. |
| Per-LLM-call tail injection | `pi.on("context", …)` — deep-copy `event.messages`; return `{ messages }` with the recall package appended. Session transcript stays clean; prefix untouched. |
| Injection ledger (durable) | `pi.appendEntry("com.mjaric.session-memory.injected", …)`; rebuild from `ctx.sessionManager.getBranch()` on start/switch/branch/tree. |
| Cache telemetry | assistant message `usage.cacheRead` / `usage.cacheWrite` / `usage.input` available on session entries — read from `ctx.sessionManager.getBranch()` in `turn_end`. |
| End-of-session drain | `session_shutdown` — bounded flush of pending index writes (managed timers only). |

## 4. Storage

Root: `~/.omp/session-memory/<workspace-basename>-<hash>/` (same derivation as
file-graph). Files: `index.sqlite` (chunks + FTS5 + vectors), `turns.jsonl`
(telemetry rows, append-only, JSON-per-line).

`chunks` table: id, session_id, role, turn_no, text, text_hash, embedding
(BLOB float32), token_estimate, created_at, compacted (bool).

Vector search: brute-force cosine over stored float32 vectors. Rationale:
session-scale corpora (≤ tens of thousands of chunks); a dependency-free
baseline first. ANN index is an open optimization, not v1.

## 5. Embedding endpoint chain (shared design with file-graph)

Ordered OpenAI-compatible endpoint list `{ name, baseUrl, apiKey?, model }`;
first-healthy wins; failed primary gets a cooldown before retry. Configured
via `SMEM_ENDPOINTS` (JSON array) or `/smem config endpoints <json>`.
Defaults for the author's environment: primary = remote ollama (RTX box),
fallback = local Mac ollama (`mxbai-embed-large`), optional cloud. The chain
exists because the GPU box is loud at night — switching to local/cloud must be
one config line, never a code change.

Embedding dimension is per-endpoint; store rows record the model name. If the
active embedding model changes, old vectors are not compared against new ones
(version tag in the vector column; re-embed lazily or on explicit
`/smem rebuild`).

## 6. Write path

1. `message_end` → filter (user + assistant text only; skip empty/tool noise),
   chunk by message boundaries first, then size-cap splitting (~1200 tokens
   per chunk, sentence-aware).
2. Embed + hash; upsert into SQLite (dedup by text_hash per session).
3. Deferred through `ctx.setTimeout` with bounded concurrency; failures log
   and skip (indexing must never break the session).
4. `session_shutdown`: bounded drain (≤2 s), then detach — mirror mnemopi's
   shutdown discipline.

## 7. Read path (the prefix-safe trick)

On `input` event (interactive) or explicit `smem_recall`:

1. Embed the prompt (+ last user-bounded turns if present).
2. Retrieve top-k chunks (cosine; k configurable, default 8; boosted:
   `compacted = true` chunks score a fixed bonus).
3. **Dedup against current context** — two layers:
   a. injection ledger: chunks this session already injected (by chunk id);
   b. content match: chunk text_hash found among hashes of the current
      `event.messages` text blocks (compute in the `context` handler where
      the real message list is visible) → treated as present.
4. Build the recall package:
   - reference block: one line listing present-but-not-reinjected items by
     title/turn only;
   - new chunks only, with source attribution (`[turn 12, assistant]`).
5. The `context` handler appends exactly one custom message at the tail while
   the package is pending; clears it once the turn completes (`turn_end`).

Modes (`/smem config mode <m>`): `off` · `naive` (inject full top-k, no dedup)
· `prefix-safe` (default). `naive` exists solely as the A/B baseline.

## 8. Telemetry

`turn_end` → append row to `turns.jsonl`:
`{ ts, mode, turn_no, inputTokens, cacheRead, cacheWrite, injectedChunks,
injectedChars, dedupedChunks, recallMs }`.

`smem_stats` tool + `/smem stats`: per-session aggregates and the raw path.
Comparison protocol (documented in README): run similar workloads under
`naive` and `prefix-safe`, compare `cacheRead / inputTokens` trajectories.

## 9. Tools & commands

Tools: `smem_recall` (explicit, agent-driven) · `smem_stats` ·
`smem_status` (endpoint chain health, index size, mode).
Commands: `/smem stats` · `/smem config <key> <json>` · `/smem rebuild`
(re-embed) · `/smem clear`.

## 10. Testing requirements

- chunking: boundaries, size caps, empty/noise filtering;
- dedup: ledger replay correctness; content-hash match; compacted boost;
- context handler: returned messages = input + exactly one appended message;
  prefix slice byte-identical (property test); pending package cleared on
  turn_end;
- modes: `off` emits nothing; `naive` skips dedup;
- endpoint chain: fallback on fetch failure (mocked network), cooldown reset;
- telemetry: row shape + aggregates;
- shutdown: drain bounded (fake timers).

## 11. Implementation order

1. Store + chunking + endpoint chain (+ fallback tests).
2. Write path (message_end → index) with shutdown drain.
3. Read path: retrieve → dedup → context-handler injection; modes.
4. Telemetry (turn_end rows, smem_stats).
5. Marketplace entry, README (incl. the A/B comparison protocol), tests green.

## 12. Open questions (explicitly deferred)

- Attention behavior for reference-then-detail: measure after v1 using the
  telemetry above; this is experiment design, not a blocker.
- Whether `naive` mode should ship disabled-by-default permanently.
- ANN index if brute-force cosine stops scaling (threshold: measure first).
