/**
 * `/forge guide` — the short user manual, shown in the TUI.
 *
 * Workflow-oriented complement to the README: what to run in which
 * order, the board rules forge enforces, and how to read the plan.
 */

import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

/** Terse user manual for the forge loop. */
export const FORGE_GUIDE = `
Forge — short user manual

THE LOOP (in order)
  setup        once per repo: discover the Projects v2 board, write .forge.toml,
               install the sdlc + forge-retrospect skills into .omp/skills/
  round        sync the board (promote unblocked; green-CI In progress -> In review;
               merged PRs -> Done)
  promote      move unblocked, acceptance-written issues Backlog -> Ready
  dispatch N   verify blockers, card -> In progress, print the worker prompt
  review N     LLM: review a PR against the issue's acceptance criteria
  retrospect   after a milestone: findings + improvements (opt-in)
  Autopilot    "run a round" / "pokreni petlju" runs one sdlc-skill round;
               repeat under /loop for continuous rounds

BOARD RULES (what forge checks, zero LLM)
  Blockers   native GitHub "blocked by" relationships + "Blocked by #N" body lines;
             an issue is blocked while any blocker is open
  Promote    no open blockers AND a written Acceptance section; checkboxes are the
             worker's TDD checklist and stay unchecked until implemented
  Dispatch   Ready + no open blockers only; forge never merges or pushes

READING /forge plan
  Dispatchable  Ready + unblocked — workers can start now
  Promotable    Backlog + unblocked + acceptance written — run promote/round
  Blocked       open blockers listed per issue
  Not ready     Backlog without a written Acceptance section — fix the issue body
  Reviewable    In review with a linked PR — run review N

TROUBLESHOOTING
  .forge.toml not found     run setup in the repo (once per repo)
  auth errors               gh auth login or GH_TOKEN; doctor checks
  stale board ids           doctor offers to rewrite .forge.toml
  issue stuck in Backlog    check sidebar "blocked by" links + Acceptance section
`;

/** Show the guide. */
export function cmdGuide(ctx: ExtensionCommandContext): void {
	if (ctx.hasUI) ctx.ui.notify(FORGE_GUIDE, "info");
}
