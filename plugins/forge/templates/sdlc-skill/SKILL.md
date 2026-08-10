---
name: sdlc
description: Run ONE round of the spec-driven SDLC loop — sync the board, read the plan, dispatch TDD workers (max 4, isolated worktrees), review PRs, report. Triggers on "run a round", "run one round", "run the sdlc loop", "start the sdlc loop", "pokreni petlju", "jedan krug". Designed to be driven repeatedly by `/loop`; never loops internally.
---

# SDLC Round

You run **one round per activation**. Repetition comes from `/loop` (or the
user re-asking) — never loop inside this skill. One pass, then a terse report
and yield.

The forge plugin does all deterministic GitHub work (board reads/writes,
blocker checks, CI status). You do the reasoning: what to dispatch, spawning
workers and reviewers, routing findings.

## Tools you use

| Tool | Effect | Mutates? |
|---|---|---|
| `forge_sync` | Promote unblocked Backlog → Ready; green-CI In progress → In review (undraft PR); merged In review → Done | Yes |
| `forge_plan` | Round plan: dispatchable / reviewable / promotable / blocked / needs-decision / milestones | No |
| `forge_dispatch {issue}` | Verify unblocked, card → In progress, returns the worker prompt | Yes |
| `forge_review {number}` | Acceptance review contract for an issue/PR | No |
| `task` | Spawn worker / reviewer subagents (isolated worktrees) | Yes |
| `hub` | Watch in-flight worker jobs (`wait`); route findings back (`send`) | — |

Never call `gh` for board or blocker checks — forge tools do it deterministically
and for free. Use `gh`/`read` only for spec or repo content.

The user may interleave `/forge …` commands at any point; the board is the
source of truth, so your next round simply adapts.

## The round (one pass, in order)

1. **Sync** — `forge_sync` first, so promotions and In-review moves land
   before you read state.
2. **Plan** — `forge_plan`; read every section.
3. **Stop checks** (report and yield; a human must act):
   - `needsDecision` non-empty → STOP. List the decisions, instruct
     `/forge decide N <text>` and pausing `/loop` (Esc). NEVER guess past a
     needs-decision issue.
   - Active milestone complete → STOP. Report completion, offer
     `/forge retrospect`.
   - Idle (nothing actionable, nothing in flight) → STOP. Report that the
     board is idle and the loop can be disabled.
4. **Review** everything `reviewable`:
   - `forge_review {number}` → contract; spawn the bundled `reviewer` agent
     via `task`: review the change for issue #N against the contract, diff at
     `pr://<PR>/diff/all`; check every criterion has a real test, the gate
     passes, no stubs/placeholders.
   - Clean → leave for the human merge (card is already In review).
   - Findings → route back to the same worker: `hub send` when the worker is
     parked, else a follow-up `task` carrying the findings.
5. **Dispatch** everything `dispatchable`, capped at 4:
   - `forge_dispatch {issue}` per issue → worker prompts.
   - ONE `task` call with parallel `tasks[]`: each `agent: "task"`,
     `isolated: true`, `task` = the returned prompt verbatim.
   - Worker contract is already in the prompt (branch rule, TDD, gate, draft
     PR `Fixes #N`). Add nothing unless `rules/` says so.
   - If `rules/` names a stack-specific agent (e.g. `rust-impl`) and it
     exists, use it instead of `task`.
6. **Settle in-flight work** — if workers are still running and nothing else
   is actionable, `hub wait` on their jobs so their results land this round;
   then re-run steps 1–4 once before reporting. If waiting is unavailable,
   yield — results wake the session and the next round picks them up.

## Reporting

End every round with a terse report:

- dispatched: issue numbers + worker handles
- reviewed: PR numbers + verdict (clean / findings)
- blocked: issue numbers + reason
- decisions needed: issue numbers
- milestone progress: done/total for the active milestone
- next: what the next round will pick up

## Project rules

Before the first dispatch of a session, read:

- `rules/*.md` — project-specific corrections (gate overrides, stack agent
  selection, extra PR conventions). They override this protocol.
- `references/*.md` — learned context from past rounds and retrospectives.
  Read when relevant to a decision.

If neither has content, this protocol stands as-is.

## Running under /loop

The intended driver:

```
/loop Run one round of the sdlc loop.
```

Each yield re-submits the prompt → the next round. The loop can dispatch,
implement, and review, but it **cannot ship**: merges stay human. Esc cancels
the current iteration; `/loop` again disables the mode.
