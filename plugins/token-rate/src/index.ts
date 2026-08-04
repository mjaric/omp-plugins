import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  type RateState,
  computeRate,
  createRateState,
  finalizeRate,
  formatRate,
  recordChars,
} from "./rate-calculator";

/**
 * Token-rate extension: shows tokens/sec in a below-editor widget during
 * streaming, then displays the authoritative rate from provider usage on
 * message_end.
 *
 * One persistent calibrated ratio is kept per session and refined after each
 * message — the ratio adapts to the active model's tokenizer.
 */

/** Minimum ms between live widget updates (avoid render spam). */
const LIVE_UPDATE_INTERVAL_MS = 300;

export default function tokenRate(pi: ExtensionAPI): void {
  let state: RateState | null = null;
  let lastWidgetUpdate = 0;
  let calibratedRatio: number | null = null;

  pi.setLabel("Token Rate");

  pi.on("message_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    state = createRateState(Date.now());
    lastWidgetUpdate = 0;
  });

  pi.on("message_update", async (event, ctx) => {
    if (!ctx.hasUI || !state) return;
    const delta = event.assistantMessageEvent;
    if (delta?.type !== "text_delta") return;

    recordChars(state, delta.delta.length);

    // Apply the ratio learned from the previous message, if any.
    if (calibratedRatio !== null) {
      state.charsPerToken = calibratedRatio;
    }

    const now = Date.now();
    if (now - lastWidgetUpdate < LIVE_UPDATE_INTERVAL_MS) return;
    lastWidgetUpdate = now;

    const rate = computeRate(state, now);
    if (rate !== null) {
      ctx.ui.setWidget("token-rate", [`tok/s: ${formatRate(rate)}`], {
        placement: "belowEditor",
      });
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!ctx.hasUI || !state) return;

    const message = event.message;
    const outputTokens =
      message?.role === "assistant" ? message.usage.output : 0;

    const result = finalizeRate(state, Date.now(), outputTokens);
    calibratedRatio = result.calibratedRatio;

    if (result.rate !== null) {
      ctx.ui.setWidget("token-rate", [`tok/s: ${formatRate(result.rate)} ✓`], {
        placement: "belowEditor",
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state = null;
    if (ctx.hasUI) {
      ctx.ui.setWidget("token-rate", [], { placement: "belowEditor" });
    }
  });
}
