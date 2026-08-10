# SDLC loop — project rules

Drop `.md` files here to adjust the sdlc loop for THIS project. The loop
skill reads every file in this directory before dispatching.

Examples of useful rules:

- **Gate override**: the repo's gate differs from `.forge.toml` —
  e.g. "add `bun run check` to the gate for TypeScript packages."
- **Stack agent**: "use the `rust-impl` agent for issues labeled `rust`."
- **PR conventions**: "workers must label PRs with `impl` and add a
  Changeset entry."
- **Scope guard**: "never touch `docs/spec/*` — spec is frozen during
  implementation."

Rules are plain prose or checklists; keep each file focused on one concern.
Empty directory = the generic protocol in SKILL.md stands unchanged.
