# file-graph

A workspace knowledge-graph indexer for markdown. Builds per-document
outlines, extracts entities, and constructs typed cross-file relations —
stored as a durable, inspectable graph (ubiquitous language).

## Gate 0: Parser decision

**Hand-rolled line-oriented parser.** `web-tree-sitter@0.26.11` fails to
initialise under Bun (`Parser.init` / namespace export is `undefined`), and no
markdown grammar ships bundled — loading one requires a network-fetched `.wasm`
artifact (forbidden in tests per spec §12). The annotation convention is fully
line-oriented (frontmatter, ATX headings, bracket-ID scan), so a hand-rolled
parser is exact and dependency-free.

## Annotation convention (spec §5)

Documents opt into the graph via YAML frontmatter and inline bracket IDs.

### Frontmatter

```yaml
---
title: Claims Registry
purpose: Source of truth for what is established (C1–C23).
entities: [claim, verification, trust-level]
relations:
  - "[SP7] gates [C13]"
  - "[C13] derived-from [C4]"
---
```

- `title`: falls back to the first ATX heading when frontmatter omits it, so
  workspaces without frontmatter stay navigable.
- `purpose`: missing is a `fg_stats` warning, not an error.
- `entities`: canonical terms this document owns.
- `relations`: typed edges as `"[ID-A] verb [ID-B]"`. The verb is lowercased
  and kebab-normalised into the relation type (e.g. `derived-from`).

### Inline references

Body text `[C4]` creates a `mentions` edge from the file to entity `C4`.
Pattern: `\[([A-Za-z]{1,10})(\d+(?:\.\d+)?)\]` — namespace prefix + numeric id
with optional `.sub` (e.g. `[RQ2.1]`). Bracketed words that are not profile
namespaces are ignored (e.g. `[INFERENCE]`).

### Profiles

- `generic` (default): no namespaces; inline scanner OFF unless `namespaces`
  is configured via `/fg config`. Frontmatter relations still parse.
- `zksrc`: namespaces `C, RQ, SP, D, S`. Entity **definition site** = first
  file where the ID appears as a table-row first cell (`|C4|`), a heading
  containing the ID, or bold `**C4**`. Unresolvable IDs stay as dangling nodes.

## Config keys

| key | default | description |
|---|---|---|
| `profile` | `generic` | `generic` or `zksrc` |
| `namespaces` | `[]` | inline-scan namespace prefixes (overrides profile) |
| `rerankEnabled` | `false` | enable optional second-stage rerank |
| `rerankTopN` | `12` | candidates sent to rerank |
| `endpoints` | `[]` | OpenAI-compatible endpoint chain (JSON array) |

Env override: `FILEGRAPH_ENDPOINTS` (JSON array of `{ name, baseUrl, apiKey?, model }`).

Set via `/fg config <key> <json-value>` or the `FILEGRAPH_ENDPOINTS` env var.

## Tools

| tool | purpose |
|---|---|
| `fg_search` | query the graph (lexical + graph, optional rerank) |
| `fg_outline` | heading outline of one file or whole workspace |
| `fg_relations` | edges for a file/entity; `view=mermaid` for a graph diagram |
| `fg_suggest` | candidate computation for the current prompt |
| `fg_export` | write `UBIQUITOUS-LANGUAGE.md` + `GRAPH.md` |
| `fg_stats` | counts, dangling refs, missing-purpose, store path |

## Commands

```
/fg reindex              # rebuild the graph (incremental by mtime + content hash)
/fg stats                # show graph statistics
/fg config               # show current config
/fg config <key> <json>  # set a config key
/fg export <lang> <graph>  # export glossary + edge list
/fg view                 # mermaid graph of the whole workspace
```

## Interactive UX (spec §8)

The plugin suggests workspace content that is relevant to the current prompt
but **not already in context**, and lets you choose what gets injected.
Injection is always **tail-side** so the prompt-cache prefix stays intact, and
the injected block is framed as reference material — never as instructions.

```
user prompt ──► input event: silent candidate query
                 │  widget above the editor lists top candidates
                 ▼
              press alt+g
                 │  multi-select checklist → editor review (prune excerpts)
                 ▼
              selection saved (session state)
                 │  context event appends ONE reference message per LLM call
                 ▼
              turn_end clears the selection (one turn of reference)
```

- **`input`**: on each interactive submit, relevant not-in-context files are
  shown in a banner above the editor with an `alt+g` hint. Silent — it never
  blocks the agent loop.
- **`alt+g`**: opens the review flow. Pick candidates (multi-select checklist,
  falling back to a single-select loop on surfaces without `askDialog`), prune
  excerpts in an editor dialog, confirm. The package is injected as reference
  material for the current turn.
- **Keyboard shortcut**: `alt+g`. The spec text wrote `alt-g`, but the verified
  `KeyId` token format (`${modifier}+${key}`) is `alt+g`; `alt-g` is not a valid
  `KeyId` and would not compile. `alt+g` is not in the reserved app keybindings.

Candidates are filtered against what is already in context: workspace-relative
paths referenced in the session branch, plus a fingerprint match against the
current messages (so already-quoted material is not re-suggested).

### Headless behaviour

In print / RPC / subagent modes (`ctx.hasUI === false`) the widget and dialogs
are suppressed and `alt+g` only notifies. The `fg_suggest` tool remains the
agent-driven path to pull candidates explicitly.

## Storage

The graph database lives outside the user project at
`~/.omp/file-graph/<basename>-<hash>/graph.sqlite` (hash = stable SHA-256 of
the absolute workspace path). No cache files are written into the indexed
workspace.

## Architecture

```
src/
  index.ts              extension factory (register at load, act in handlers)
  types.ts              shared domain types
  workspace.ts          path derivation, markdown discovery, gitignore
  indexer.ts            incremental reindex orchestration
  profiles/profiles.ts  generic + zksrc profile data
  parser/               hand-rolled frontmatter + outline + bracket scan
  tools/                fg_* tool registrations
  commands/             /fg command routing
  ux/                   interactive suggestion flow (candidates, selection, inject)
  query/                search (FTS5/LIKE + graph), mermaid, export, rerank
  config/               endpoint-chain config model
```

## Development

```bash
bun run --cwd plugins/file-graph check   # tsc --noEmit
bun run --cwd plugins/file-graph test    # bun test (86 tests)

Tests use Bun's native test runner (`bun:test`) because vitest's Node-based
workers cannot load `bun:sqlite`. Parser and config tests are pure; store and
query tests exercise the real SQLite database against temp workspaces.
