# session-memory

Live session index with **prefix-safe recall**: index every user/assistant
message in flight, and on the next prompt inject only what is NOT already in
context — keeping the context prefix byte-identical so provider KV/prompt
caches keep hitting.

## How it works

- **Write path** — `message_end` → chunk (message boundaries, ~1200-token
  sentence-aware cap) → embed via the endpoint chain → `bun:sqlite`
  (`~/.omp/session-memory/<workspace>-<hash>/index.sqlite`), deduped by text
  hash per session. Compaction events flag affected chunks as recall-first.
- **Read path** — embed the prompt, brute-force cosine top-k (compacted chunks
  get a fixed boost), then a two-layer dedup: the durable injection ledger
  (session custom entries) and a content-hash match against the current LLM
  context.
- **Injection** — the `context` handler appends exactly one message at the
  tail while a package is pending: a reference block ("already covered: …")
  plus genuinely new chunks with `[turn N, role]` attribution. The prefix is
  never touched.

## Recall modes (`/smem config mode <json>`)

| mode | behavior |
|---|---|
| `prefix-safe` (default) | dedup on; references + new chunks only |
| `naive` | full top-k, no dedup — the A/B baseline |
| `off` | no recall, indexing continues |

## Endpoint chain

Ordered OpenAI-compatible `/embeddings` endpoints, first-healthy-wins with a
cooldown on failure. Set via `SMEM_ENDPOINTS` (JSON array, env wins) or
`/smem config endpoints <json>`:

```json
[
  { "name": "rtx", "baseUrl": "http://gpu-box:11434/v1", "model": "mxbai-embed-large" },
  { "name": "mac", "baseUrl": "http://127.0.0.1:11434/v1", "model": "mxbai-embed-large", "apiKey": "sk-..." }
]
```

Embeddings are tagged with the model that produced them; vectors from
different models are never compared. `/smem rebuild` re-embeds after a model
change.

## A/B comparison protocol

Run comparable workloads under `naive` and `prefix-safe`; compare via
`/smem stats`: headline metric is `cacheRead / (input + cacheRead)` per turn,
plus injected bytes and dedup percentage. Rows land in
`~/.omp/session-memory/<workspace>/turns.jsonl`.

## Telemetry row shape

```json
{ "ts": "ISO-8601", "mode": "prefix-safe", "turnNo": 4, "inputTokens": 100,
  "cacheRead": 90, "cacheWrite": 5, "injectedChunks": 2, "injectedChars": 120,
  "dedupedChunks": 1, "recallMs": 12 }
```

## Tools & commands

- `smem_recall` — explicit agent-driven recall (dry-run package)
- `smem_stats` — telemetry aggregates
- `smem_status` — endpoint chain health, index size, mode
- `/smem stats | config <key> <json> | rebuild | clear`

## Development

```bash
bun run --cwd plugins/session-memory check   # tsc --noEmit
bun test plugins/session-memory              # colocated bun tests
```

Design spec: `docs/specs/2026-08-05-session-memory-design.md`.
