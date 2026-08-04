/**
 * Pure token-rate calculation logic — no I/O, no omp types.
 *
 * Separated from the extension factory so it is unit-testable without
 * mocking the extension runtime.
 */

/** Default chars-per-token ratio (English text approximation). */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/** Minimum elapsed seconds before a rate is computed (avoids div-by-near-zero). */
export const MIN_ELAPSED_SECONDS = 0.3;

/** State tracked across streaming events for a single assistant message. */
export interface RateState {
  /** High-resolution timestamp (ms) of the first text_delta. */
  readonly startTs: number;
  /** Total output characters observed so far. */
  chars: number;
  /** Total output tokens from provider usage (0 until message_end). */
  outputTokens: number;
  /** Empirically calibrated chars/token ratio (starts at default). */
  charsPerToken: number;
}

/** Create fresh state at message_start. */
export function createRateState(now: number): RateState {
  return {
    startTs: now,
    chars: 0,
    outputTokens: 0,
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
  };
}

/** Record incoming text characters. Returns updated state (mutates in place). */
export function recordChars(state: RateState, charCount: number): RateState {
  state.chars += charCount;
  return state;
}

/** Estimated tokens from observed characters using the current ratio. */
export function estimatedTokens(state: RateState): number {
  return state.chars / state.charsPerToken;
}

/**
 * Compute tokens/sec from elapsed time.
 * Returns `null` if not enough time has passed.
 */
export function computeRate(state: RateState, now: number): number | null {
  const elapsedSec = (now - state.startTs) / 1000;
  if (elapsedSec < MIN_ELAPSED_SECONDS) return null;
  const tokens = estimatedTokens(state);
  return tokens / elapsedSec;
}

/**
 * Finalize with provider-reported output_tokens.
 * Returns the authoritative tokens/sec and recalibrates the chars/token ratio
 * for future messages on the same model.
 */
export function finalizeRate(
  state: RateState,
  now: number,
  outputTokens: number,
): { rate: number | null; calibratedRatio: number } {
  const elapsedSec = (now - state.startTs) / 1000;
  if (elapsedSec <= 0) {
    return { rate: null, calibratedRatio: state.charsPerToken };
  }

  state.outputTokens = outputTokens;

  // Calibrate: if provider tokens > 0, learn the real ratio.
  if (outputTokens > 0 && state.chars > 0) {
    state.charsPerToken = state.chars / outputTokens;
  }

  const tokens = outputTokens > 0 ? outputTokens : estimatedTokens(state);
  return { rate: tokens / elapsedSec, calibratedRatio: state.charsPerToken };
}

/** Format a rate value for display. */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  const rounded = Math.round(rate);
  return rounded >= 1000 ? `${(rounded / 1000).toFixed(1)}k` : String(rounded);
}
