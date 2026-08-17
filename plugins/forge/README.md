# forge

Spec-driven SDLC loop plugin for omp. Turns a spec-driven repo into a self-driving delivery
pipeline: decompose spec slices into GitHub issues, dispatch TDD workers, review PRs, sync a
Projects v2 board, and promote issues as blockers clear.

**Human-gated at the merge boundary**: forge dispatches, implements, and reviews; you merge.
For the organizational model — roles, authority, and control gates — see
[docs/sdlc.md](docs/sdlc.md).

## How it works

```
spec  ──decompose──▶  issues (milestone = slice)
                         │ impl label
                         ▼
              board (Projects v2, Status field)
                         │ dispatch (verified unblocked)
                         ▼
           worker (isolated worktree, TDD)
                         │ draft PR "Fixes #N"
                         ▼
              CI ──▶ review ──▶ you merge ──▶ Done
```

Most operations run in TypeScript (GitHub SDK calls, board sync, blocker checks) — **zero LLM
tokens for mechanical work**. The LLM is invoked only for reasoning tasks: decompose (spec
→ issues), dispatch (code writing), and review (diff analysis).

## Board rules (what forge checks, zero LLM)

- **Blockers** — native GitHub "blocked by" relationships plus `Blocked by #N` lines in the
  issue body. An issue is blocked while any blocker is open.
- **Promotion** — a Backlog issue moves to Ready when it has no open blockers **and** a
  written `## Acceptance` section. Checkbox state is the worker's TDD checklist: criteria are
  written (with test names) at decompose time and stay unchecked until implemented.
- **Dispatch** — only Ready issues without open blockers; forge never merges or pushes.
  Worker branches are `impl/<issue>-<title-slug>` (slugified from the issue title).
- **Rework** — when a reviewer requests changes on an In review PR, the card bounces back
  to In progress; the review contract carries the feedback to the worker.
- **Cleanup** — after a merge reaches Done, sync removes the merged PR's worktree and
  branch locally (squash-merge aware) and prunes stale remote-tracking refs.
- **Ownership** — a repo's board must be owned by the same account that owns the repo.
  `/forge setup` lists only boards owned by the repo's owner (organization or personal),
  linked-to-repo boards first, and every board read/mutation re-checks ownership at
  runtime, so a stale `.forge.toml` can never drive another account's board.

`/forge guide` prints the short user manual (loop order, board rules, how to read the plan,
troubleshooting).

## Two control surfaces

Forge exposes the same loop mechanics through two seams:

1. **Slash commands** (`/forge ...`) — user-invoked, notify in the TUI.
2. **Agent tools** (`forge_plan`, `forge_sync`, `forge_dispatch`, `forge_review`) —
   callable mid-turn, used by the `sdlc` skill to run the loop autonomously.

Both are thin adapters over the same `src/loop` modules; there is one implementation.

## Commands

| Command | LLM? | Effect |
|---|---|---|
| `/forge setup` | — | Interactive: discover boards owned by the repo's owner (org or personal), linked boards first, detect fields, write `.forge.toml`, install loop skills; ownership is enforced at runtime on every board access |
| `/forge board [filter]` | — | Board snapshot grouped by Status |
| `/forge plan` | — | Query-only round plan: dispatchable / reviewable / promotable / blocked / milestones |
| `/forge promote` | — | Find unblocked + acceptance-written → move to Ready |
| `/forge decide <N> <decision text>` | — | Record decision, close issue, report unblocked |
| `/forge status` | — | One-liner per project (multi-repo) |
| `/forge round` | TS | Sync board: promote unblocked backlog → Ready, green-CI In progress → In review (undraft), requested-changes In review → back to In progress (rework), merged → Done + local worktree/branch cleanup |
| `/forge doctor` | — | Diagnose environment + board sync; offer fixes for stale IDs |
| `/forge dispatch <N>` | TS + LLM | Verify blockers, move card, emit worker prompt |
| `/forge decompose <slice>` | LLM | Spec slice → GitHub issues |
| `/forge decompose <slice>` | LLM | Spec slice → GitHub issues |
| `/forge review <N>` | LLM | Review PR against acceptance criteria + human review feedback |
| `/forge thinking-report` | — | Thinking-level telemetry analysis (requires `self_improvement`) |
| `/forge retrospect [--milestone N]` | — | Milestone retrospective: findings + recommendations (requires `self_improvement`) |

## Agent tools (the loop seam)

| Tool | Approval | Effect |
|---|---|---|
| `forge_plan` | read | Round plan JSON: dispatchable, reviewable, promotable, blocked, needs-decision, milestone completion; nothing mutated |
| `forge_sync` | write | Promote eligible backlog → Ready; green-CI In progress → In review (undraft PR); requested-changes In review → back to In progress (rework); merged In review → Done + cleanup of merged-PR worktrees/branches |
| `forge_dispatch {issue}` | write | Verify unblocked, card → In progress, return worker prompt (branch `impl/N-<title-slug>`) |
| `forge_review {number}` | read | Return the acceptance review contract for an issue/PR, including human review feedback (verdicts + comments) |

`forge_plan` caps `dispatchable` at 4 workers (the loop's concurrency ceiling).

## Loop skills (installed by `/forge setup`)

Setup copies two skill templates into `<repo>/.omp/skills/` — the project owns them afterwards:

- **`sdlc`** — one round per activation: `forge_sync` → `forge_plan` → dispatch up
  to 4 TDD workers via `task` (isolated worktrees) → review PRs via the bundled
  `reviewer` agent → report and yield. Repetition comes from `/loop` (or the user
  re-asking); the skill never loops internally. Stops a round at milestone
  completion, an idle board, or `needs-decision` issues. Project corrections live
  in `.omp/skills/sdlc/rules/`; learned context in `.omp/skills/sdlc/references/`.
- **`forge-retrospect`** — milestone self-improvement: reads the `/forge retrospect` analysis
  and proposes improvements as reviewable diffs to sdlc rules/references, helper scripts, and
  new omp agents/roles. Nothing is applied without your approval.

## Setup

```bash
# Install from marketplace
omp plugin install forge@mjaric-omp-plugins

# Or local dev
omp plugin link ./plugins/forge

# In your project:
/forge setup
# → discovers Projects v2 board, writes .forge.toml, installs sdlc + retrospect skills
```

## Configuration (`.forge.toml`)

Generated by `/forge setup`. Lives in repo root.

```toml
repo = "owner/name"
project_id = "PVT_..."
status_field_id = "PVTSSF_..."
status_options = { backlog = "...", ready = "...", in_progress = "...", in_review = "...", done = "..." }
gate = ["cargo test", "cargo clippy --all-targets -- -D warnings"]
spec_id_prefix = "REQ"
```

### Multi-project (git submodules)

```toml
[workspace]
type = "submodules"

[[projects]]
path = "projects/smith"
repo = "owner/smith"
project_id = "PVT_..."
# ... same fields per project
```

The project is resolved automatically from the current directory's git remote
origin — no manual flag needed. Each coding task belongs to exactly one repo;
run the forge command from within that repo's working directory (or submodule
checkout). `/forge status` spans all configured projects.

## Auth

Forge resolves a GitHub token in this order:

1. `~/.config/gh/hosts.yml` (the file `gh auth login` writes)
2. `gh auth token` (covers Keychain-stored credentials on macOS)
3. `GH_TOKEN` environment variable
4. `GITHUB_TOKEN` environment variable

## Requirements

- omp v17.2+
- Bun 1.3.14+
- `gh` CLI authenticated (or `GH_TOKEN` env var)
- A GitHub Projects v2 board with a Status single-select field

## Architecture

```
src/
├── index.ts                    # extension factory — registers /forge command,
│                               # forge_* tools + telemetry handler
├── commands/
│   ├── forge-command.ts        # subcommand routing + all handlers
│   ├── board-render.ts         # table formatting (testable without ExtensionAPI)
│   └── guide.ts                # /forge guide — the short user manual
├── config/
│   ├── forge-toml.ts           # hand-rolled TOML parser/writer for .forge.toml
│   ├── forge-config-loader.ts  # loads .forge.toml from cwd
│   └── git-remote.ts           # origin remote → owner/name resolution
├── loop/                       # the loop seam (shared by commands and tools)
│   ├── plan.ts                 # buildForgePlan: query-only round plan
│   ├── dispatch.ts             # dispatchIssue: verify + move card + worker prompt
│   ├── round.ts                # syncBoard: promote + done (the mutation half)
│   ├── resolve.ts              # client + config resolution (single/multi-project)
│   ├── tools.ts                # forge_* agent tools (sdlc skill surface)
│   └── install-skills.ts       # skill template installation for setup
├── doctor/
│   └── doctor.ts               # environment + board sync diagnostics, fix suggestions
├── github/
│   ├── auth.ts                 # token resolution: hosts.yml → gh CLI → env
│   ├── client.ts               # shared Octokit instance (REST + GraphQL)
│   ├── board.ts                # Projects v2: getBoardState, moveCard, addIssueToBoard
│   ├── issue.ts                # blockers, acceptance parsing, linked PR, close
│   └── pr.ts                   # CI status, review contract assembly
├── retrospect/
│   └── retrospect.ts           # milestone retrospective: GitHub + telemetry → findings
└── telemetry/
    ├── types.ts                # ThinkingTelemetryEntry, pattern types
    └── telemetry.ts            # turn_end handler, analysis, report formatting
templates/
├── sdlc-skill/                 # loop orchestration skill (+ rules/, references/)
└── retrospect-skill/           # self-improvement skill
```

## Self-improvement (v2, opt-in)

Self-improvement features are **off by default**. Enable them explicitly in
`.forge.toml`:

```toml
self_improvement = true
```

When enabled:

- **Telemetry**: per-turn records (thinking level, model/provider, tool calls/errors,
  retries) are appended to the session journal. `/forge thinking-report` analyzes them
  for overthinking / underthinking / high-retry-rate patterns and model distribution.
- **Retrospective**: `/forge retrospect [--milestone N]` combines GitHub
  delivery data (done issues, PR linkage, CI status) with session telemetry
  into findings and recommendations. The `forge-retrospect` skill turns those
  into reviewable diffs (rules, references, helper scripts, agents, roles).

## Doctor (new machine / board drift)

Moved to a new computer, or suspect the board changed? Run:

```
/forge doctor
```

Checks: `.forge.toml` presence, GitHub auth, gate binaries on PATH, board
accessible, status field ID currency, and status option IDs against the
live board. When stale board IDs are detected, forge offers to rewrite
`.forge.toml` with current values — one confirmation per fix.

## Deferred to v3

- **Agent evolution loop**: apply retrospective recommendations as git diffs
  to worker prompts / skills / spec sections (human reviews, forge commits)
- **Cross-project learning**: insights from project A pre-seed instructions for project B
- **Auto thinking-level adjustment**: raise/lower level per task type based on telemetry patterns
