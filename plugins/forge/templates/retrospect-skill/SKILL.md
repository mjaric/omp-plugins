---
name: forge-retrospect
description: Run a milestone retrospective after the sdlc loop finishes — analyze delivery data and telemetry, then propose concrete improvements as git diffs to the sdlc skill rules/references, helper scripts, and omp agent/role definitions. Triggers on "retrospect", "retrospective", "what should we improve", or when a milestone completes.
---

# Forge Retrospective

Turn a finished milestone into concrete, reviewable improvements for the
next one. You receive analysis data from `/forge retrospect --milestone N`
(the forge plugin collects GitHub delivery data + session telemetry). Your
job: read the findings, inspect the current skill/rules/references/agents,
and PROPOSE improvements as diffs the user approves.

## Inputs

1. The retrospective report the plugin emitted (summary, findings,
   recommendations) — it is in this conversation's context.
2. GitHub delivery data you may pull yourself: PR review round-trips,
   CI failure patterns, dispatch→merge times (`gh` read-only queries).
3. Telemetry patterns from `/forge thinking-report` (thinking levels,
   model distribution, retry rates) — ask the user to run it if missing.
4. Current state of the improvement targets (below).

## Improvement targets (in priority order)

### 1. Loop skill rules — `.omp/skills/sdlc/rules/`

Workflow corrections learned this milestone. Examples:
- Workers kept forgetting a gate step → add a rule making it explicit.
- Reviewer repeatedly flagged the same anti-pattern → add a rule forbidding it.
- A stack consistently needed extra context → add a rule pointing at it.

### 2. References — `.omp/skills/sdlc/references/`

Durable knowledge the loop should carry forward: architecture decisions,
known flaky tests, module ownership, spec ambiguities that got resolved.

### 3. Helper scripts — `scripts/forge/` (propose new)

Mechanical work that repeated across workers should become a script the
worker prompt can call: gate wrappers, test-name validators, branch-name
generators. Propose the script + the rules/ line that references it.

### 4. Agents and roles — `.omp/agents/*.md`, `.omp/config.yml`

When telemetry or delivery data shows a task class needs different treatment:
- **New agent**: `.omp/agents/<name>.md` with focused instructions, the
  right `tools` list, and a `model: "@<role>"` alias.
- **New role**: `modelRoles.<role>` entry in `.omp/config.yml` pointing at a
  model/thinking level suited to the task class (e.g. a high-thinking role
  for concurrency-heavy Rust work that showed high retry rates).

Ground every agent/role proposal in observed evidence from this milestone —
never propose one "just in case". Use the model distribution from telemetry
to pick model ids actually in use.

## Output format

For each proposal:

1. **What** — the file change, as a diff (`edit`-ready or unified).
2. **Why** — the specific evidence (finding id, PR numbers, retry stats).
3. **Risk** — what could go wrong if applied.

Present ALL proposals first, then ask the user which to apply. Apply only
approved ones, one file at a time, then stop. Do NOT commit unless the user
asks; do NOT modify `.forge.toml`, the forge plugin source, or the board.

## Hard rules

- Never delete existing rules/references — propose edits or additions.
- Never apply a change without explicit user approval.
- Keep proposals small and reversible; prefer two small diffs over one big one.
- If the data shows the loop worked well, say so — "no changes needed" is a
  valid outcome.
