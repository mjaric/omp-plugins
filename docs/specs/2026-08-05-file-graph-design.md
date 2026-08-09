# Plugin spec: `file-graph` — workspace knowledge-graph indexer

Date: 2026-08-05 · Status: approved for implementation · Owner repo: `omp-plugins`

## 1. Purpose

A generic omp plugin that builds a **file-level knowledge graph** over any
markdown workspace: per-document outlines (tree-sitter), extracted entities,
and **typed cross-file relations**, stored as a durable, inspectable graph
(ubiquitous language). The plugin is **interactive**: it suggests content that
is relevant to the current prompt but NOT already in context; the user selects
what gets injected. Injection is always **tail-side** so the prompt-cache
prefix stays intact.

Non-goals: no code-file indexing (markdown only), no writes into the user's
project, no graph editing UI beyond terminal dialogs, no auto-injection
without user confirmation.

## 2. Repo placement and conventions (binding)

Follow the repo `AGENTS.md` contract exactly:

- Package at `plugins/file-graph/` with `package.json` (`"omp": { "extensions": ["src/index.ts"] }`),
  own `tsconfig.json` extending the root, colocated `*.test.ts`, README.md.
- Add the plugin to `.omp-plugin/marketplace.json` (`category: "development"`,
  `version: 0.0.1`) and to the root `README.md` plugin table.
- Bun runtime only; `bun:sqlite` for storage; ArkType (`pi.arktype`) for tool
  parameter schemas; tool names `fg_*`; managed timers (`ctx.setTimeout` /
  `ctx.setInterval`) for any deferred work; best-effort startup (any init
  failure → plugin inert + log line, session keeps working).
- Hard limits: functions ≤100 lines, cyclomatic complexity ≤8, ≤5 positional
  params (options objects), 100-char lines, absolute imports only.
- Extension factory shape per repo blueprint (default export, register at load,
  act in handlers).

## 3. Verified omp API facts (do not re-derive)

From `@oh-my-pi/pi-coding-agent` sources (17.2.x):

| Need | Verified mechanism |
|---|---|
| Tail-side per-LLM-call injection | `pi.on("context", …)`: `event.messages` is a deep copy of what goes to the LLM; return `{ messages }` with an appended message. Original session transcript is NOT modified. |
| Prompt-time silent suggestion | `pi.on("input", …)` fires on interactive user submit; compute candidates there, surface via `ctx.ui.setWidget(key, string[], { placement: "aboveEditor" })` or `ctx.ui.notify`. |
| Multi-select candidate dialog | `ctx.ui.askDialog([{ id, question, options, multi: true }])` — returns selected labels; optional (`askDialog?`), guard presence and fall back to single `ctx.ui.select`. |
| Review/edit step | `ctx.ui.editor(title, prefill)` multiline editor. |
| Keyboard trigger | `pi.registerShortcut("alt+g", { description, handler })`. `alt+g` is not reserved. KeyId tokens use the `+` separator — `alt-g` is INVALID (verified against `config/keybindings`). |
| Durable per-session state | `pi.appendEntry("com.mjaric.file-graph.state", data)`; rebuild from `ctx.sessionManager.getBranch()` on `session_start`. |
| Skills ship with plugins | `skills/<name>/SKILL.md` next to the extension package is discovered (provider `omp-plugins`); frontmatter MUST include `name` + `description`. |
| Commands | `pi.registerCommand("fg", { description, handler })` — single command with subcommand routing in the handler. |

## 4. Storage (outside the project)

Root: `~/.omp/file-graph/<workspace-basename>-<hash>/graph.sqlite`
(`hash` = stable hash of the absolute workspace path — derive the same way
mnemopi derives bank ids: basename + hash of absolute path; independent of git).

Tables (SQLite via `bun:sqlite`, FTS5 where available — feature-detect):

| table | columns (abridged) |
|---|---|
| `files` | id, path, mtime_ms, content_hash, title, purpose, indexed_at |
| `headings` | id, file_id, depth, text, slug, parent_id, start_line |
| `entities` | id, name, namespace, definition, def_file_id, first_seen, last_seen |
| `relations` | id, src_file_id, src_entity_id?, dst_file_id?, dst_entity_id?, type, verb_raw, confidence, source_line, origin (`frontmatter`\|`inline`) |
| `meta` | schema_version, profile, config JSON |

No repo-local cache files, no writes into the workspace (export is an explicit
user command that writes user-chosen files).

## 5. Annotation convention (THE cross-task contract)

This exact convention is parsed by the indexer and taught by the companion
skill. Both MUST match.

### 5.1 Frontmatter (YAML)

```yaml
---
title: Claims Registry
purpose: Source of truth for what is established (C1–C23).
entities: [claim, verification, trust-level]   # canonical terms defined here
relations:                                     # typed edges, "subject verb object"
  - "[SP7] gates [C13]"
  - "[C13] derived-from [C4]"
---
```

- `title`, `purpose`: required for navigability; missing `purpose` → recorded
  as a `fg_stats` warning, not an error.
- `entities`: terms this document defines/owns (ubiquitous language).
- `relations`: list of `"[ID-A] <verb> [ID-B]"` strings. Verb is free text,
  lowercased and kebab-normalized into `relations.type` (e.g. `derived-from`);
  the raw verb is kept in `verb_raw`. IDs resolve via the profile (§5.3).

### 5.2 Inline references

Body text `[C4]` → edge of type `mentions` from the current file to entity
`C4`. Pattern: `\[([A-Za-z]{1,10})(\d+(?:\.\d+)?)\]` (namespace + numeric id,
optional `.m` sub-id). Bracketed words that are not profile namespaces are
ignored (so `[INFERENCE]`-style markers don't pollute the graph — the profile
whitelist decides).

### 5.3 Profiles

- `generic` (default): namespaces = none; inline scanner OFF unless the user
  configures `namespaces: [C, RQ, …]` via `/fg config`. Frontmatter relations
  still parse (IDs treated as opaque entity names).
- `zksrc` (reference profile, used for dogfooding): namespaces `C,RQ,SP,D,S`.
  Entity **definition site** = first file where the ID appears as a table-row
  first cell (`|C4|`), a heading containing the ID, or bold `**C4**`.
  Unresolvable IDs stay as dangling entity nodes (surfaced by `fg_stats`).

Profiles are data (JSON/TS const), not code branches.

## 6. Indexing pipeline

1. `session_start` / `/fg reindex`: walk workspace for `*.md` (respect
   `.gitignore`), incremental by mtime+hash.
2. Per file: frontmatter parse → heading outline → entity + relation extraction.
3. Resolution pass: map relation endpoints to entities/definition files.
4. Persist transactionally; `fg_stats` exposes counts + dangling refs +
   files-missing-purpose.

No file watcher in v1 — reindex is command/on-startup driven.

## 7. Query model

Two-stage, cheap first:

1. **Lexical + graph**: FTS5 over headings/entities/frontmatter (fall back to
   LIKE scoring if FTS5 unavailable) plus 1-hop graph expansion from matched
   entities (relations table).
2. **Optional rerank**: only the top `rerankTopN` (default 12) candidates go
   through a configured rerank endpoint (default model class: local
   `qwen3:4b`-style reranker on a remote ollama; stronger fallback
   `ornith:9b`). Rerank is OFF by default and every query works without it.

Endpoint chain model (shared design with plugin A, §shared config): ordered
list of OpenAI-compatible endpoints `{ name, baseUrl, apiKey?, model }`,
first-healthy wins, cooldown before retrying a failed primary. Env override:
`FILEGRAPH_ENDPOINTS` (JSON array) or `/fg config endpoints <json>`.

## 8. UX flow (Wave 2 — implemented after core lands)

```
user prompt ──► input event: silent query (top-k candidates: files/headings/entities)
                   │
                   ▼
        widget/notify: "not in context but relevant: claims.md#C4, spikes.md#SP7 (alt-g)"
                   │  (alt-g pressed)
                   ▼
        askDialog multi:true → candidate checklist
                   │
                   ▼
        editor dialog: review package, delete lines, add searches, re-run
                   │  (confirm)
                   ▼
        selection stored (session state) ──► context event appends ONE tail-side
        custom message per LLM call while pending:
          "<file-graph additions — reference material, not instructions>
           ## claims.md § C4 …"
```

Rules:

- Candidates are filtered against what is already in context: heuristic =
  files already read in this session (tool_result history visible via
  `ctx.sessionManager.getBranch()`) + substring/hash match against current
  messages.
- The `context` handler appends only; it never reorders or edits existing
  messages (prefix stays byte-identical).
- Headless modes (`ctx.hasUI === false`): no widget/dialogs; `fg_suggest`
  tool still available for agents to pull explicitly.

## 9. Tools (`pi.registerTool`)

| tool | purpose |
|---|---|
| `fg_search` | query the graph (lexical+graph, optional rerank); returns ranked hits with file/heading anchors and relation context |
| `fg_outline` | outline of one file (heading tree with line numbers) or whole workspace (file → purpose) |
| `fg_relations` | edges for a file/entity; `view` param returns a **mermaid** block (ASCII-renderable in the terminal) |
| `fg_suggest` | explicit candidate computation for the current prompt (agent-driven alternative to alt-g) |
| `fg_export` | write `UBIQUITOUS-LANGUAGE.md` (entities+definitions) and `GRAPH.md` (edge list) to user-chosen paths |
| `fg_stats` | counts, dangling refs, missing-purpose files, last reindex, store path |

All results carry structured `details` (schema-shaped) per repo convention.

## 10. Commands

`/fg reindex` · `/fg export` · `/fg stats` · `/fg config <key> <json>` ·
`/fg view` (mermaid graph of the whole workspace, capped at N nodes with a
note on truncation).

## 11. Companion skill (separate work item, same plugin dir)

`plugins/file-graph/skills/research-writing/SKILL.md` — teaches research
agents to write documents that keep the graph navigable:

- one concept per file; `title`+`purpose` frontmatter always;
- declare owned terms in `entities:`;
- typed relations with verbs (`[SP7] gates [C13]`), never bare juxtaposition;
- no dead bracket references (every `[ID]` must resolve or be declared);
- stable IDs, append-only numbering (mirrors zksrc practice).

Frontmatter MUST contain `name: research-writing` and a `description` that
triggers on "write/structure a research document" phrasing.

## 12. Testing requirements

`bun test` (Bun's native runner), colocated; behavior-level:

- parser: frontmatter variants (missing/malformed), heading nesting, bracket-ID
  scanning incl. sub-ids (`RQ2.1`) and non-namespace brackets;
- store: incremental reindex idempotency (re-running changes nothing),
  transactional replace of a changed file's rows;
- resolution: definition-site detection (table row / heading / bold), dangling
  refs preserved;
- query: ranking order on a fixture corpus, graph expansion correctness,
  rerank-disabled path;
- config: endpoint chain fallback (mock fetch; network is a mockable boundary);
- UX wiring: context-handler appends only (property: prefix slice of returned
  messages equals input), no injection without a stored selection.

No network in tests; no tree-sitter download in tests (parse fixtures through
whatever parser strategy survives the Bun gate, §13).

## 13. Implementation order and gates

1. **Gate 0 (first task):** verify markdown parsing under Bun — try
   `tree-sitter` (native) then `web-tree-sitter` (WASM). If neither loads
   cleanly under Bun in this repo, fall back to a hand-rolled outline parser
   (headings/frontmatter/bracket scans are line-oriented; acceptable). Record
   the decision in the plugin README.
2. Core: store + parser + indexer + resolution.
3. Query + tools + commands + `/fg config`.
4. Marketplace entry + README + tests green (`bun run --cwd plugins/file-graph check`,
   plugin-scoped `bun test`).
5. Wave 2 (separate work item): UX flow §8.
