---
name: research-writing
description: 'This skill should be used when the user asks to "write a research document", "structure research notes", "create a claims registry", "start a decision log or spike registry", "add frontmatter to a markdown document", "organize an investigation into registries", or "write a note that stays navigable". Teaches the annotation convention that keeps the file-graph knowledge graph machine-navigable: title/purpose frontmatter, owned entities, typed relations, and resolvable bracket references.'
---

# Research-Writing for the file-graph Knowledge Graph

The `file-graph` plugin builds a navigable knowledge graph from markdown
frontmatter and bracket references. Write documents the way the graph
expects and every claim, spike, and decision stays queryable and linked.

The reference workspace is `zksrc` (dogfooded under the `zksrc` profile).

## Rules

1. **One concept per file.** A claims registry owns claims; a spike
   registry owns spikes. Splitting by concept is what makes `entities:`
   and `relations:` meaningful. If a file defines two unrelated concepts,
   split it.

2. **Always set `title` and `purpose` in frontmatter.** `title` names the
   document; `purpose` says what it owns in one line. A missing `purpose`
   is not an error but is reported by `fg_stats` as a warning — fix it.

3. **Declare owned terms in `entities:`.** List the ubiquitous-language
   terms this document defines. A claims file might own `claim`,
   `trust-level`; a sources file owns `source`, `trust-tier`.

4. **Write typed relations with an explicit verb.** Frontmatter
   `relations:` are strings of the form `"[ID-A] verb [ID-B]"`. The verb is
   free text; the indexer lowercases and kebab-normalizes it into the edge
   `type` and keeps the raw verb. A verb-less line creates no useful edge.

   ```yaml
   # Good — explicit verb, two-way navigable
   relations:
     - "[SP7] gates [C13]"
     - "[C13] derived-from [C4]"

   # Bad — no verb, no edge type; the two IDs merely sit next to each other
   relations:
     - "[SP7] [C13]"
   ```

5. **Every bracket reference must resolve.** Inline body text `[C4]`
   becomes a `mentions` edge from this file to entity `C4`. Only profile
   namespaces form references (the `zksrc` profile whitelists `C`, `RQ`,
   `SP`, `D`, `S`); other bracketed words like `[INFERENCE]` are ignored.
   Under the default `generic` profile the inline scanner is off unless
   namespaces are configured via `/fg config` — frontmatter `relations`
   still parse. An ID that resolves nowhere stays as a dangling node that
   `fg_stats` flags.

6. **Define each ID at a definition site.** The indexer treats the first
   file where an ID appears as a **table-row first cell** (`| C4 |`), a
   **heading containing the ID**, or **bold** (`**C4**`) as the entity's
   definition site. Place each owned ID in one of these positions.

7. **Keep registries as tables with the ID as the first column.**
   Definition-site detection depends on the ID being the first cell, so a
   registry is a table, not prose bullets:

   ```markdown
   | ID | Summary | Status |
   |---|---|---|
   | C4 | BBS rejected for eIDAS | contested |
   ```

8. **Use stable, append-only IDs.** Assign an ID once and never renumber
   it. Retired claims keep their ID with a `refuted`/`superseded` status
   rather than being deleted; new claims take the next free number. The
   `zksrc` registries run `C1`–`C23` with no gaps reused.

## Common Mistakes

- **Dead references.** A bracket `[ID]` that no file defines becomes a
  dangling node. Before writing `[SP7]`, confirm the spike exists in
  `spikes.md` or declare it here.
- **Missing `purpose`.** A document with a title but no `purpose` is
  invisible to outline queries (`fg_outline`) and warns under `fg_stats`.
- **Relations without verbs.** `"[SP7] [C13]"` produces no typed edge.
  Always name the relationship: `gates`, `derived-from`, `supersedes`.
- **IDs renumbered.** Reusing a retired ID or compacting the list breaks
  every relation and bracket pointing at it. Append only; never renumber.
- **Two concepts in one file.** A file that defines both claims and
  decisions muddies its `entities:` and defeats one-concept-per-file.

## Complete Example

A file that parses cleanly under the `zksrc` profile — every referenced
ID (`C4`, `C13`, `SP7`) has a definition site inside it, so there are no
dangling references:

```markdown
---
title: Threat Model Summary
purpose: Owns the trust-level term and links claims to the spike gating them.
entities: [trust-level]
relations:
  - "[SP7] gates [C13]"
  - "[C13] derived-from [C4]"
---

# Threat Model

Every claim carries a `trust-level`; [C4] sets the substrate choice.

| ID | Summary | Status |
|---|---|---|
| C4 | BBS rejected for eIDAS; SD-JWT VC chosen | contested |
| C13 | Sigstore + personhood: an empty niche | unverified |

**SP7** must close before [C13] enters the white paper (see spikes.md).
Without [SP7], [C13] stays an unverified absence claim.
```

`C4` and `C13` are defined as table-row first cells; `SP7` is defined by
the bold `**SP7**`. The two frontmatter relations and the inline
mentions all resolve, so the graph links this file cleanly to the rest
of the workspace.
