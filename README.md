# omp-plugins

Personal [omp](https://github.com/can1357/oh-my-pi) plugins — a monorepo with
multiple plugins published through a single private marketplace catalog.

## Plugins

| Plugin | Version | Description |
|---|---|---|
| [token-rate](plugins/token-rate/) | 0.1.0 | Tokens/sec generation rate widget during model responses |
| [remote-memory](plugins/remote-memory/) | 0.0.1 | Remote, portable agent memory — recall, retain, reflect, share _(skeleton)_ |
| [file-graph](plugins/file-graph/) | 0.0.1 | Workspace knowledge-graph indexer for markdown — outlines, entities, typed cross-file relations |
| [session-memory](plugins/session-memory/) | 0.0.1 | Live session index with prefix-safe recall — inject only what's not already in context |
| [forge](plugins/forge/) | 0.0.1 | Spec-driven SDLC loop — decompose, dispatch, review, and sync a GitHub Projects v2 board |

User manual for `file-graph`, `session-memory`, and `forge` (Serbian):
[USER-MANUAL.md](USER-MANUAL.md).

## Quick start

### Install from marketplace (private repo)

```bash
# Add this repo as a marketplace source (SSH for private repos)
omp plugin marketplace add git@github.com:mjaric/omp-plugins.git

# Install a plugin
omp plugin install token-rate@mjaric-omp-plugins
omp plugin install remote-memory@mjaric-omp-plugins
omp plugin install file-graph@mjaric-omp-plugins
omp plugin install session-memory@mjaric-omp-plugins
omp plugin install forge@mjaric-omp-plugins
```

### Local development (link)

```bash
git clone git@github.com:mjaric/omp-plugins.git
cd omp-plugins
bun install

# Link individual plugins for live editing
omp plugin link ./plugins/token-rate
omp plugin link ./plugins/remote-memory
omp plugin link ./plugins/file-graph
omp plugin link ./plugins/session-memory
omp plugin link ./plugins/forge
```

Verify installation:

```bash
omp plugin list          # CLI
/plugins list            # inside an omp session
```

## Repository structure

```
omp-plugins/
├── .omp-plugin/
│   └── marketplace.json          # marketplace catalog (lists all plugins)
├── plugins/
│   ├── token-rate/               # tokens/sec widget plugin
│   ├── remote-memory/            # remote memory backend plugin (skeleton)
│   ├── file-graph/               # markdown knowledge-graph indexer
│   ├── session-memory/           # prefix-safe session recall
│   └── forge/                    # spec-driven SDLC loop over a Projects v2 board
│       ├── src/
│       │   ├── commands/         # /forge subcommands + guide
│       │   ├── loop/             # plan/dispatch/round seam (commands + agent tools)
│       │   ├── github/           # Octokit: board, issues, PRs, auth
│       │   └── index.ts          # extension factory
│       └── templates/            # sdlc + retrospect skill templates
├── package.json                 # bun workspace root
├── tsconfig.json                # shared strict TS config
└── .oxlintrc.json               # oxlint config
```

The marketplace catalog at `.omp-plugin/marketplace.json` declares each plugin
with its `source` path (relative to `plugins/`). Adding a new plugin is:

1. Create `plugins/<name>/` with a `package.json` containing an `"omp"`
   manifest pointing at the extension entry.
2. Add an entry to `marketplace.json`.

## Development

```bash
bun install          # install dependencies (root workspace)
bun run check        # tsc --noEmit + oxlint (zero warnings required)
bun run fmt          # oxfmt
bun test             # vitest (all workspaces)
```

### Requirements

- [Bun](https://bun.sh) 1.3.14+
- omp v17.2+

### Conventions

- **Runtime**: Bun only (not Node)
- **Package manager**: bun (single root lockfile)
- **Lint/format/types**: oxlint + oxfmt + tsc --noEmit
- **Tests**: vitest, colocated `*.test.ts` next to sources
- **Style**: ESM, strict TypeScript, kebab-case files, snake_case tool names

See [AGENTS.md](AGENTS.md) for the full engineering blueprint.
