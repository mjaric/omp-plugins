# remote-memory

omp plugin that gives agents remote, portable memory — recall, retain,
reflect, and share knowledge across machines, projects, and teammates.

> **Status: skeleton.** The extension factory and `.mcp.json` are in place but
> the backend client, tools, and lifecycle handlers are not yet implemented.
> See [TODO](#roadmap).

## Design (planned)

Two components work together:

1. **Extension** (`src/index.ts`) — owns session lifecycle automation:
   - `session_start` → auto-recall from the project bank
   - `turn_end` → throttled auto-retain (default every 4 user turns)
   - `session_shutdown` → bounded drain of pending retains
2. **MCP config** (`.mcp.json`) — points the backend at an HTTP MCP server so
   tools are also reachable as `mcp__rmem_*` in any MCP-capable client.

### Tools (planned)

| Tool | Purpose |
|---|---|
| `rmem_recall` | Retrieve memories from the project bank |
| `rmem_retain` | Store a new memory |
| `rmem_reflect` | Consolidate / distill existing memories |
| `rmem_share` | Grant membership on a bank to a teammate |

### Scoping modes

| Mode | Writes | Recall |
|---|---|---|
| `global` | shared bank | shared bank |
| `per-project` | project bank | project bank only |
| `per-project-tagged` | project bank | project bank + global, merged |

### Safety

- **Best-effort startup**: if the backend is unreachable or auth fails, the
  extension goes inert and the agent session keeps working.
- **Secrets via env only**: `${MEMORY_API_URL}` / `${MEMORY_API_TOKEN}` in
  `.mcp.json`; tokens never in code, config files, logs, or stored memory.
- **Never default-open sharing**: bank membership is explicit (read or write).

## Install

```bash
omp plugin marketplace add git@github.com:mjaric/omp-plugins.git
omp plugin install remote-memory@mjaric-omp-plugins
```

## Configuration

Environment variables (set before starting omp):

| Variable | Required | Description |
|---|---|---|
| `MEMORY_API_URL` | yes | Backend HTTP endpoint |
| `MEMORY_API_TOKEN` | yes | Bearer auth token |

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Extension factory (skeleton — session handlers are no-op) |
| `.mcp.json` | Backend MCP server entry (HTTP + Bearer token) |

## Roadmap

- [ ] Backend HTTP client (fetch wrapper, auth, retries)
- [ ] Bank-id derivation + scoping modes (`src/scoping.ts`)
- [ ] Tools: `rmem_recall`, `rmem_retain`, `rmem_reflect`, `rmem_share`
- [ ] Auto-recall at `session_start`
- [ ] Throttled auto-retain at `turn_end`
- [ ] Bounded drain at `session_shutdown`
- [ ] Redaction of secrets before store

See the root [AGENTS.md](../../AGENTS.md) for the full architectural blueprint.
