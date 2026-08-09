# token-rate

omp plugin that shows the model's generation speed (tokens/sec) in a widget
below the editor during streaming responses, then displays the authoritative
rate from provider usage when the message completes.

## How it works

```
message_start  → reset timer
message_update → count chars, update widget every 300ms:  "tok/s: 42"
message_end    → read usage.output from provider:         "tok/s: 42 ✓"
                 calibrate chars/token ratio for next message
session_shutdown → clear widget
```

During streaming, tokens are estimated from character count using a
chars-per-token ratio. The default ratio is `4` (English text approximation).
After each message completes, the ratio is recalibrated from the provider's
actual `usage.output`, so the estimate adapts to the active model's tokenizer
over the course of a session.

The widget renders via `ctx.ui.setWidget("token-rate", [...], { placement:
"belowEditor" })` and appears only in interactive (TUI) mode. In print, RPC,
or subagent sessions (`ctx.hasUI === false`) the extension is inert.

## Install

### Via marketplace (private repo)

```bash
omp plugin marketplace add git@github.com:mjaric/omp-plugins.git
omp plugin install token-rate@mjaric-omp-plugins
```

### Local link (development)

```bash
omp plugin link ./plugins/token-rate
```

Then restart omp and verify:

```bash
omp plugin list          # token-rate should appear as enabled
```

## Requirements

- omp v17.2+
- Bun 1.3.14+

## Configuration

None. The extension is zero-config — it activates automatically when installed
and enabled.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Extension factory — wires streaming events to the widget |
| `src/rate-calculator.ts` | Pure rate-calculation logic (no omp types, fully unit-testable) |
| `src/rate-calculator.test.ts` | 14 unit tests covering thresholds, calibration, formatting |

## Development

```bash
bun install                # from repo root
bun run check              # tsc --noEmit + oxlint
bun test                   # vitest
```

To iterate without reinstalling, use `omp plugin link` — the symlink picks up
source changes on restart.
