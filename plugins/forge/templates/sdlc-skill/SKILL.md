---
name: sdlc
description: Orchestrate the spec-driven SDLC loop — read the forge plan, dispatch TDD workers for Ready issues (max 4 parallel), review PRs, sync the board, and stop at milestone completion. Triggers on "run the loop", "run a round", "start the sdlc loop", or goal-mode implementation runs.
---

# SDLC Loop Orchestration

You orchestrate a GitHub-Projects-driven delivery loop for a spec-driven repo.
The **forge plugin** does all deterministic GitHub work (board reads/writes,
blocker checks, CI status). You do the reasoning: deciding what to dispatch,
reviewing results, and knowing when to stop.

## Tools you use

| Tool | Effect | Mutates? |
|---|---|---|
| `forge_plan` | Round plan: dispatchable / reviewable / promotable / blocked / milestones | No |
| `forge_sync` | Promote unblocked Backlog → Ready; merged In review → Done | Yes |
| `forge_dispatch {issue}` | Verify unblocked, card → In progress, returns worker prompt | Yes |
| `forge_review {number}` | Returns the review contract for an issue/PR | No |
| `task` | Spawn worker / reviewer subagents (isolated worktrees) | Yes |

Never call `gh` directly for board or blocker checks — the forge tools do it
deterministically and for free. Use `gh`/`read` only for spec or repo content.

## The loop protocol

```
START
  │
  ├─ forge_sync                    # promote newly eligible issues first
  │
  ├─ forge_plan                    # read current state
  │     │
  │     ├─ needsDecision non-empty? ── STOP: report the decisions to the user.
  │     │                                NEVER guess past a needs-decision issue.
  │     │
  │     ├─ milestone complete?    ── STOP: report, offer `/forge retrospect`
  │     │
  │     ├─ idle (nothing actionable, nothing in flight)?
  │     │                         ── STOP: nothing left to do. Report state.
  │     │
  │     ├─ dispatchable non-empty ── dispatch up to 4 workers (see below)
  │     │
  │     ├─ reviewable non-empty   ── run reviews (see below)
  │     │
  │     └─ otherwise              ── wait for in-flight workers; when all
  │                                  settle, forge_sync and loop back to forge_plan
  │
  └─ repeat
```

Stop conditions (any one ends the loop):

1. **Milestone complete** — `forge_plan` reports the active milestone with
   `complete: true` (all issues Done). Report completion and offer
   `/forge retrospect`.
2. **Nothing actionable** — plan is `idle` and no workers in flight.
3. **Needs decision** — any `needsDecision` item. Surface it to the user.
4. **User stops** — the user says stop / interrupts.

## Dispatching workers

For each issue in `dispatchable` (capped at 4, prefer the `dispatchNow` list
from `forge_plan` details):

1. Call `forge_dispatch {issue: <N>}` — returns the worker prompt.
2. Spawn a worker with the `task` tool:
   - `agent: "task"`, `isolated: true` (worktree)
   - `task`: the worker prompt returned by `forge_dispatch`, verbatim
3. Dispatch all eligible issues **in one `task` call** (parallel `tasks[]`),
   never sequentially.

Worker contract is already in the prompt (branch rule, TDD, gate, draft PR
with `Fixes #N`). Do not add extra instructions unless `rules/` says so.

If `rules/` defines a stack-specific agent name (e.g. `rust-impl`), use that
agent instead of `task` — but only when it exists; otherwise fall back.

## Reviewing PRs

For each item in `reviewable`:

1. Call `forge_review {number: <issue>}` — returns the acceptance contract.
2. Spawn the bundled `reviewer` agent via `task`:
   - `task`: review the change for issue #N against this contract. Fetch the
     diff via `pr://<PR>/diff/all`. Check every acceptance criterion has a
     real test, the gate passes, and there are no stubs/placeholders. Report
     findings by severity.
3. Clean + CI green → leave for the user to merge (human-gated boundary).
   Findings → route back to the same worker (via `hub` message or a
   follow-up task) until clean.

## Project rules

Before the first dispatch of a session, read the project-local rules:

- `.omp/skills/sdlc/rules/*.md` — project-specific corrections (gate
  overrides, stack agent selection, extra PR conventions). Apply any rule
  found there; they override the generic protocol above.
- `.omp/skills/sdlc/references/*.md` — learned context from past rounds and
  retrospectives. Read when relevant to a decision.

If neither directory has content, the generic protocol stands as-is.

## Reporting

After each round (and on every stop), give a terse report:

- dispatched: issue numbers + worker agents
- reviewed: PR numbers + verdict (clean / findings)
- blocked: issue numbers + reason
- decisions needed: issue numbers
- milestone progress: done/total per active milestone
- next recommended action
