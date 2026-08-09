# Plugin spec: `forge` — spec-driven SDLC loop with GitHub board state machine

Date: 2026-08-09 · Status: DRAFT — pending review · Owner repo: `omp-plugins`

## 1. Purpose

Generalize the Smith implementation loop into a reusable omp plugin. Forge turns a
spec-vodeni repo into a self-driving delivery pipeline: decompose spec slices into
GitHub issues, dispatch TDD workers, review PRs, sync a Projects v2 board, and promote
issues as blockers clear — all driven by TypeScript commands that call the GitHub SDK
directly, with LLM invoked only for reasoning tasks (decompose, review, code).

The loop is **human-gated at the merge boundary**: forge dispatches, implements, and
reviews; the human merges. This is the intended safety boundary.

Success is measured by: (a) zero LLM tokens spent on mechanical board/issue/PR
operations; (b) a new project goes from `forge setup` to first dispatched worker in
under 5 minutes; (c) the board never desynchronizes from GitHub state.

### Relationship to Smith's `.omp/`

Smith's `.omp/commands/*.md` and `.omp/agents/team-lead.md` are the prototype. Forge
absorbs their workflow logic into TypeScript, replacing markdown-prompt-to-LLM calls
with direct SDK calls for all mechanical operations. The LLM agent contract (TDD,
zero-warnings gate, worker isolation) stays — but it is dispatched by TypeScript code,
not authored by an LLM reading a markdown command.

### Relationship to other omp-plugins

Forge is independent of `file-graph` and `session-memory`. It does not index files or
manage context. It is purely a GitHub state-machine driver + LLM dispatcher.

## 2. Repo placement and conventions (binding)

Same binding contract as `file-graph` / `session-memory` specs:

- Package at `plugins/forge/`; marketplace entry in `.omp-plugin/marketplace.json`.
- Runtime: Bun ≥ 1.3.14; ESM only; strict tsconfig matching repo conventions.
- Lint/format/types: `oxlint` + `oxfmt` + `tsc --noEmit`, zero warnings.
- Schema authoring: ArkType (`pi.arktype`) for tool parameter schemas.
- Best-effort startup: if GitHub auth fails or `.forge.toml` is missing, forge goes
  inert and commands report "forge not initialized" — the session keeps working.
- Managed timers only (`ctx.setInterval` / `ctx.setTimeout`); raw timers are banned.
- Tool/command names: `forge` prefix (`/forge setup`, `/forge board`, etc.).
- Hard limits: ≤100 lines/function, cyclomatic complexity ≤8, ≤5 positional params,
  100-char lines, absolute imports only.

## 3. Verified omp API facts (do not re-derive)

| Need | Verified mechanism |
|---|---|
| Slash commands | `pi.registerCommand("forge", { handler(args, ctx) })` — subcommand routing in handler. `ExtensionCommandContext` extends `ExtensionContext` with `waitForIdle()`, `newSession()`, `branch()`, `switchSession()`. |
| Shell exec (for `git submodule`, `cargo`, etc.) | `pi.exec(command, args, options)` → `ExecResult`. |
| Interactive setup dialog | `ctx.ui.askDialog(questions: ExtensionAskDialogQuestion[])` → multi-question select with options, `recommended`, `multi`. Falls back gracefully when `ctx.hasUI === false`. |
| Status bar (live board indicator) | `ctx.ui.setStatus(key, text)` — persistent footer line. `ctx.ui.setStatus(key, undefined)` clears. |
| LLM tool dispatch (workers, reviewer) | `pi.registerTool(...)` with `execute` that calls `pi.sendUserMessage()` or injects a task prompt. Alternatively, `/forge dispatch` constructs a prompt and calls `ctx.waitForIdle()` after. **Design decision: forge does NOT register LLM tools in v1.** It constructs prompts and emits them via `pi.sendMessage()` as `deliverAs: "nextTurn"` with `triggerTurn: true`, letting the main agent loop handle dispatch. This avoids duplicating the task/subagent machinery. |
| Thinking level read/set | `pi.getThinkingLevel(): ThinkingLevel \| undefined` / `pi.setThinkingLevel(level)`. Available now for thinking-level instrumentation (retrospective v2). |
| Session history (retrospective) | `ctx.sessionManager: ReadonlySessionManager` — `getBranch()` returns session entries. Available for reading session content in `/forge retrospect` (v2). |
| Event hooks | `pi.on("turn_end", handler)` — for per-turn telemetry. `pi.on("session_start", ...)` — for config load. `pi.on("tool_result", ...)` — for capturing worker output. |
| Config persistence | `pi.appendEntry("com.mjaric.forge.config", data)` — durable, rebuilt from `ctx.sessionManager.getBranch()` on start/switch/branch. NOT for `.forge.toml` (that's a file in the repo); for session-local forge state. |
| Notifications | `ctx.ui.notify(message, "info" \| "warning" \| "error")`. |

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  /forge command (pi.registerCommand)                             │
│  routes: setup | board | decompose | dispatch | review |        │
│          decide | round | promote | status                      │
└──────┬──────────────────┬────────────────────┬──────────────────┘
       │                  │                    │
       ▼                  ▼                    ▼
┌──────────────┐  ┌───────────────┐  ┌──────────────────┐
│ github/      │  │ config/       │  │ loop/            │
│ client.ts    │  │ forge-toml.ts │  │ round.ts         │
│ board.ts     │  │ (read/write   │  │ (orchestrate:    │
│ issue.ts     │  │  .forge.toml) │  │  board → blockers│
│ pr.ts        │  │               │  │  → dispatch →    │
│ (Octokit     │  │               │  │  review → sync)  │
│  SDK calls)  │  │               │  │                  │
└──────────────┘  └───────────────┘  └──────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  GitHub (Projects v2 board + issues + PRs)        │
│  via @octokit/graphql + @octokit/rest             │
│  Auth: hosts.yml → GH_TOKEN → GITHUB_TOKEN        │
└──────────────────────────────────────────────────┘
```

### Code vs. LLM division

| Operation | Executor | Rationale |
|---|---|---|
| Board status read | **TypeScript** (Octokit GraphQL) | Pure data query, no reasoning. |
| Board card move | **TypeScript** (Octokit GraphQL mutation) | Mechanical, must be deterministic. |
| Issue blocker check | **TypeScript** (Octokit REST) | Graph traversal, boolean result. |
| CI status check | **TypeScript** (Octokit REST) | Poll check runs, parse state. |
| Acceptance-complete check | **TypeScript** (parse issue body for `## Acceptance` section + unchecked boxes) | Regex/structure check. |
| `.forge.toml` read/write | **TypeScript** | File I/O. |
| `git submodule` operations | **TypeScript** (`pi.exec("git", [...])`) | Mechanical git. |
| `/forge decide` (record + close + propagate) | **TypeScript** | Update issue body, close, find unblocked. |
| `/forge promote` | **TypeScript** | Find unblocked + acceptance-complete → move to Ready. |
| `/forge decompose N` | **LLM** | Read spec, create issues. Requires reasoning + spec comprehension. |
| `/forge dispatch N` | **TypeScript + LLM** | TS verifies + moves card; LLM writes code (via prompt to main agent or subagent). |
| `/forge review N` | **LLM** | Read diff against acceptance criteria. Requires judgment. |
| `/forge round` | **TypeScript orchestrates; LLM for dispatch+review** | TS drives the loop; delegates reasoning. |

**Result: 7 of 9 subcommands spend zero LLM tokens.** Only `decompose`, `review`, and
the code-writing part of `dispatch` invoke the LLM.

## 5. GitHub integration (`github/client.ts`)

### Authentication (`hosts.yml` → env fallback)

```typescript
// github/auth.ts
interface GhAuth { token: string; source: "hosts-yml" | "env"; }

function resolveToken(): GhAuth | null {
  // 1. Try ~/.config/gh/hosts.yml (YAML parse — github.com: oauth_token: ...)
  // 2. Fallback: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  // 3. Return null if neither (forge goes inert)
}
```

The token resolved here feeds `@octokit/graphql` and `@octokit/rest` instances. One
shared `Octokit` client per session, cached in runtime state.

### Dependencies

```json
{
  "@octokit/graphql": "=9.0.7",
  "@octokit/rest": "=22.0.0",
  "yaml": "=2.7.1"
}
```

Exact-pinned per repo convention. `yaml` for parsing `hosts.yml` and writing
`.forge.toml` (TOML chosen for human-editability + comment support; we ship a tiny
TOML reader/writer — no runtime dep, TOML is simple enough for our schema).

### Board operations (`github/board.ts`)

All Projects v2 GraphQL lives here. Forge never emits GraphQL from commands or agents.

```typescript
interface BoardState {
  items: Array<{
    issueNumber: number;
    title: string;
    state: "OPEN" | "CLOSED";
    status: string;        // Status field value
    slice: string | null;  // Slice field value, if configured
    milestone: string | null;
  }>;
}

async function getBoardState(client: Octokit, config: ForgeConfig): Promise<BoardState>;
async function moveCard(client: Octokit, config: ForgeConfig, issueNumber: number, status: string): Promise<void>;
async function addIssueToBoard(client: Octokit, config: ForgeConfig, issueNodeId: string): Promise<string>;
```

`moveCard` resolves issue → project item id (query by content) → field update mutation.
Caches the project item id map per session (refreshed on miss).

### Issue operations (`github/issue.ts`)

```typescript
interface IssueBlockers {
  openBlockers: number[];   // issue numbers
  allBlockers: number[];
}
async function getBlockers(client: Octokit, repo: string, issueNumber: number): Promise<IssueBlockers>;
async function getLinkedPr(client: Octokit, repo: string, issueNumber: number): Promise<number | null>;
async function getAcceptanceSection(client: Octokit, repo: string, issueNumber: number): Promise<{ complete: boolean; missing: string[] }>;
```

`getBlockers` uses the Timeline events API (`cross-referenced`, `closed` as
duplicate-of) + body parsing for "Blocked by #N" lines. GitHub's native
`blocked_by` relationships (if enabled) are checked first.

`getAcceptanceSection` parses the issue body for a `## Acceptance` heading and
counts unchecked `- [ ]` boxes. Complete = zero unchecked.

### PR operations (`github/pr.ts`)

```typescript
type CiState = "pass" | "fail" | "pending" | "none";
async function getCiStatus(client: Octokit, repo: string, prNumber: number): Promise<CiState>;
async function getReviewContract(client: Octokit, repo: string, issueNumber: number): Promise<ReviewContract>;
```

`ReviewContract` = the issue's Scope + Spec references + Acceptance sections,
assembled into a prompt-ready string for the reviewer.

## 6. Configuration (`.forge.toml`)

Lives in the repo root. `forge setup` generates it; `forge config` edits it.

```toml
# .forge.toml — generated by `forge setup`
repo = "mjaric/smith"                      # owner/name (from git remote)
project_id = "PVT_kwHOAAT9884Bf1hn"        # Projects v2 node id (discovered)
status_field_id = "PVTSSF_lAAT9884..."     # discovered
status_options = { backlog = "bedc5e5a", ready = "2c22bc92", in_progress = "47fc9ee4", in_review = "37cbfc5d", done = "98236657" }

# Optional: slice field (omit if project has no slice/phased structure)
slice_field_id = "PVTSSF_lAAT9884..."
slice_label_prefix = "slice-"              # label "slice-1" → slice option lookup

# Gate: commands forge workers must pass before yielding
gate = ["cargo test", "cargo clippy --all-targets -- -D warnings", "bunx vitest", "bunx oxlint"]

# Spec configuration (for decompose + acceptance checks)
spec_id_prefix = "REQ"                      # requirement ID scheme
spec_index = "docs/AGENTS.md"              # reverse-index (optional)

# Worker configuration
worktree_root = "/tmp"                      # where isolated worktrees are created
worker_model = "@default"                   # model for worker subagents (optional)
```

### Multi-repo: git submodules

For a workspace repo that holds `docs/` + project submodules:

```toml
# .forge.toml (workspace root)
[workspace]
type = "submodules"

[[projects]]
path = "projects/smith"                     # submodule path
repo = "mjaric/smith"
project_id = "PVT_kwHOAAT9884Bf1hn"
# ... board config per-project (same fields as above)

[[projects]]
path = "projects/other"
repo = "mjaric/other"
project_id = "PVT_kwDOTzKxFc8AAAAC..."
```

`forge board` with no args shows all projects; `forge board smith` narrows to one.
`forge dispatch N --project smith` specifies which. Without `--project`, forge infers
from `cwd` (which submodule am I in?).

**forge abstracts submodule complexity:** `forge setup --add-submodule <git-url>`
runs `git submodule add` + `git submodule update --init` + generates the `[projects]`
entry. The agent never runs git submodule commands manually.

## 7. Commands

### `/forge setup`

Interactive (uses `ctx.ui.askDialog` when `ctx.hasUI`; otherwise prompts via
`ctx.ui.input`).

Flow:
1. Detect repo from `git remote get-url origin`.
2. Discover Projects v2 boards: `gh api graphql` listing user/org projects; ask
   "Which board tracks this project?" → store `project_id`.
3. Query project fields → auto-detect Status (single-select with backlog/ready/
   in-progress/review/done-like options) and Slice (optional single-select).
4. Ask for gate commands (suggest defaults based on detected stack: Cargo.toml →
   cargo test + clippy; package.json → vitest + oxlint; pyproject.toml → pytest +
   ruff).
5. Ask for spec ID prefix (default `REQ`).
6. Write `.forge.toml`.
7. Optionally copy issue templates + `add-to-project.yml` (parametrized with
   discovered project ID + field IDs) into `.github/`.

When `--add-submodule <url>` is passed: run `git submodule add`, `git submodule update
--init`, then add a `[projects]` entry and recurse setup inside the submodule.

### `/forge board [filter]`

Zero LLM. TypeScript reads board state + renders a table grouped by Status.

```
Status     #    Title                              Slice   Blockers
Backlog    4    smith-store: SQLite schema          1       #3 (closed ✓)
Ready      —
In prog    3    smith-core: domain types            1       —
In review  —
Done       1    Smoke test: board automation        0       —

needs-decision: 0 open
contradictions: none
```

Filters: `ready`, `backlog`, `slice-1`, `blocked`, `smith` (project name in
multi-repo).

### `/forge decompose <slice>`

LLM. Constructs a prompt from:
- `.forge.toml` spec config.
- The slice's section from `spec_index` (or asks user to point at it).
- The issue template structure.

Emits the prompt via `pi.sendMessage(prompt, { triggerTurn: true, deliverAs: "nextTurn" })`
so the main agent picks it up and creates issues. After issues are created, forge
verifies they're on the board (the `add-to-project` workflow handles this; forge
double-checks).

### `/forge dispatch <N>`

TypeScript + LLM.

1. TS: `getBlockers(N)` — if open blockers exist, notify and abort.
2. TS: `moveCard(N, "in_progress")`.
3. TS: Construct worker prompt from issue body + gate commands from config.
4. Emit worker prompt via `pi.sendMessage(prompt, { triggerTurn: true })`.

The main agent loop handles the actual task/subagent dispatch. Forge's job is
verification + card sync + prompt construction — not duplicating the task tool.

### `/forge review <N>`

LLM. `N` = PR number or issue number (resolved to linked PR).

1. TS: `getReviewContract(N)` → assemble acceptance criteria.
2. TS: Emit review prompt with `pr://N/diff/all` reference + contract.

### `/forge decide <N> <decision text>`

Zero LLM. TypeScript:
1. Update issue body `## Decision` section.
2. Close issue with comment quoting the decision.
3. `getBlockers` reverse: find issues blocked by N → report which are now unblocked.
4. Recommend `forge promote`.

### `/forge round`

TypeScript orchestrates; LLM for dispatch + review.

```
for each issue in Ready:
    if getBlockers(issue).openBlockers.length == 0:
        forge dispatch(issue)         # → LLM worker
for each open PR awaiting review:
    forge review(pr)                  # → LLM reviewer
for each PR that is clean + CI green:
    moveCard(issue, "in_review")
for each merged PR:
    verify issue auto-closed → moveCard(issue, "done")
forge promote                         # → TS: unblock newly freed issues
report: dispatched / reviewed / blocked / decisions needed
```

### `/forge promote`

Zero LLM. TypeScript:
1. For each issue in Backlog: check `getBlockers` — all closed?
2. Check `getAcceptanceSection` — complete?
3. If both: `moveCard(issue, "ready")`.
4. Report promoted issues.

### `/forge status`

Zero LLM. Quick summary (one-liner per project in multi-repo):
```
smith: 1 in progress, 0 in review, 0 needs-decision, next=#4
other: 3 ready, 1 blocked
```

## 8. Issue templates

Shipped in `plugins/forge/templates/`. `forge setup --templates` copies them into the
target repo's `.github/ISSUE_TEMPLATE/`.

### `implementation-task.md`

Same structure as Smith's (Scope / Spec references / Dependencies / Acceptance +
gate), but spec ID prefix is parametrized (not hardcoded `REQ`).

### `needs-decision.md`

Same as Smith's (Question / Options / Blocks / Decision). Universal — no
project-specific content.

### `add-to-project.yml`

Parametrized workflow: reads project ID, field IDs, and option IDs from environment
variables set by `forge setup` (written into the workflow file as `env:` blocks).
Auto-adds issues labeled `impl` to the board with Status=Backlog.

## 9. Worker contract (constructed by `/forge dispatch`)

Forge assembles this prompt from `.forge.toml` + the issue body:

```
You are implementing issue #N in repo <repo>.

## Scope
<from issue body>

## Spec references
<from issue body>

## Acceptance criteria
<from issue body>

## Rules (non-negotiable)
- Work in branch impl/<N>-<slug>; never touch main.
- TDD: write failing tests for each acceptance criterion first.
- Gate before yielding (ALL must pass, zero warnings):
  <gate commands from .forge.toml>
- Open a draft PR with "Fixes #N". Report PR URL + test names.

<stack-specific guidance from .forge.toml worker_profile, if configured>
```

## 10. Testing requirements

- `forge-toml.ts`: parse + serialize round-trip; missing optional fields;
  multi-repo `[projects]` array.
- `auth.ts`: hosts.yml parse (mock file); env fallback; null when neither.
- `board.ts`: GraphQL query construction (mock Octokit); moveCard mutation;
  item-id cache + refresh-on-miss.
- `issue.ts`: blocker parsing from timeline events + body text;
  acceptance-complete detection (checked/unchecked boxes); linked-PR resolution.
- `pr.ts`: CI state aggregation from check runs.
- `forge-command.ts`: subcommand routing; unknown subcommand → usage.
- `setup.ts`: field discovery from GraphQL (mock); stack detection (Cargo.toml /
  package.json / pyproject.toml presence); `.forge.toml` generation.
- Integration: `round` orchestration against a mock GitHub (recorded responses).

Tests mock the Octokit client boundary only; forge's own logic is never mocked.

## 11. Implementation order (v1 = "Forge core")

1. **Auth + config foundation**: `auth.ts`, `forge-toml.ts` (+ tests).
2. **GitHub client layer**: `client.ts`, `board.ts`, `issue.ts`, `pr.ts` (+ tests
   against mock Octokit).
3. **Command shell**: `forge-command.ts` routing + `/forge board` (first zero-LLM
   command, proves the pipeline end-to-end).
4. **`/forge setup`**: interactive discovery + `.forge.toml` generation + template
   copying.
5. **`/forge promote`** + **`/forge decide`**: remaining zero-LLM commands.
6. **`/forge dispatch`**: TS verification + prompt construction + emit.
7. **`/forge round`**: orchestration loop tying it all together.
8. **`/forge decompose`** + **`/forge review`**: LLM prompt construction + emit.
9. **Multi-repo**: `[projects]` config + submodule management + `--project` flag.
10. Marketplace entry, README, integration test against real GitHub (Smith board).

### Proven on Smith

Before declaring v1 done, `/forge board` and `/forge round` must produce identical
results to the current Smith `.omp/commands/` — same board state, same dispatch
decisions, same promotion logic. Smith is the conformance test.

## 12. Deferred to v2 (architecture does not preclude)

- **Retrospective** (`/forge retrospect`): analyze GitHub history (PRs, issues,
  commits, review findings) + omp session logs (`ctx.sessionManager.getBranch()`)
  after a milestone. Propose agent instruction / skill / spec corrections so
  repeated mistakes are eliminated. Data sources: both GitHub (what was delivered)
  and session logs (how it was delivered — overthinking, errors, workflow).

- **Thinking-level oversight**: instrument `pi.on("turn_end", ...)` to log
  thinking level + token usage + outcome per turn. Detect patterns: overthinking
  (high thinking + trivial task + success → wasted budget) or underthinking (low
  thinking + complex task + failure/retry). Report via `/forge thinking-report`.
  Optionally auto-adjust `pi.setThinkingLevel()` per task type.

- **Agent evolution loop**: after retrospective analysis, forge proposes edits to
  worker prompts, agent skills, or spec sections. Human reviews; forge applies
  via git. This closes the feedback loop: agents get better each milestone.

- **Cross-project learning**: retrospective insights from project A can pre-seed
  agent instructions for project B (e.g., "Rust projects: always check feature
  flags before cargo test").

## 13. Open questions

1. **Worker dispatch mechanism**: v1 emits a prompt to the main agent loop via
   `pi.sendMessage`. Is this sufficient, or should forge register its own task tool
   that wraps the subagent dispatch? Deferring until v1 proves the emit approach
   works end-to-end on Smith.

2. **Octokit vs. raw `fetch`**: the repo convention (AGENTS.md §"New dependencies")
   says "prefer stdlib first." Octokit adds 3 deps. Justification: typed GraphQL
   + REST, pagination, rate-limit handling — raw fetch would reimplement all three.
   Open: is this justification accepted, or should we start with raw `fetch` +
   inline GraphQL strings (like the existing `add-to-project.yml` does)?

3. **TOML parser**: `.forge.toml` needs a parser. Options: (a) tiny hand-rolled
   parser (our schema is simple); (b) `@iarna/toml` dependency; (c) switch to JSON
   config (`.forge.json`) — less human-friendly, but zero parser dep. Leaning (a)
   for v1, (b) if the schema grows.

4. **Board field discovery**: `forge setup` auto-detects the Status field by name
   ("Status", "status", "State"). What if the project uses a non-standard name
   (e.g., "Workflow")? Fallback: ask the user to select the field from a list.
