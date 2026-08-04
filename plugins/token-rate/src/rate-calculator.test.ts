import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARS_PER_TOKEN,
  computeRate,
  createRateState,
  estimatedTokens,
  finalizeRate,
  formatRate,
  recordChars,
} from "./rate-calculator";

describe("createRateState", () => {
  it("starts with zero chars and default ratio", () => {
    const state = createRateState(1000);
    expect(state.startTs).toBe(1000);
    expect(state.chars).toBe(0);
    expect(state.outputTokens).toBe(0);
    expect(state.charsPerToken).toBe(DEFAULT_CHARS_PER_TOKEN);
  });
});

describe("recordChars", () => {
  it("accumulates character count", () => {
    const state = createRateState(0);
    recordChars(state, 100);
    recordChars(state, 50);
    expect(state.chars).toBe(150);
  });
});

describe("estimatedTokens", () => {
  it("divides chars by the current ratio", () => {
    const state = createRateState(0);
    recordChars(state, 400);
    expect(estimatedTokens(state)).toBe(100); // 400 / 4
  });

  it("reflects a calibrated ratio", () => {
    const state = createRateState(0);
    state.charsPerToken = 3;
    recordChars(state, 300);
    expect(estimatedTokens(state)).toBe(100); // 300 / 3
  });
});

describe("computeRate", () => {
  it("returns null before MIN_ELAPSED_SECONDS", () => {
    const state = createRateState(0);
    recordChars(state, 100);
    expect(computeRate(state, 100)).toBeNull(); // 0.1s
    expect(computeRate(state, 200)).toBeNull(); // 0.2s
  });

  it("computes tokens/sec after threshold", () => {
    const state = createRateState(0);
    recordChars(state, 400); // 100 tokens at default ratio
    const rate = computeRate(state, 1000); // 1 second
    expect(rate).toBe(100);
  });

  it("scales with elapsed time", () => {
    const state = createRateState(0);
    recordChars(state, 400); // 100 tokens
    const rate = computeRate(state, 2000); // 2 seconds
    expect(rate).toBe(50);
  });
});

describe("finalizeRate", () => {
  it("returns provider-token-based rate when output_tokens > 0", () => {
    const state = createRateState(0);
    recordChars(state, 500);
    const result = finalizeRate(state, 1000, 120);
    // 120 tokens / 1 second
    expect(result.rate).toBe(120);
  });

  it("calibrates chars/token ratio from real data", () => {
    const state = createRateState(0);
    recordChars(state, 500);
    const result = finalizeRate(state, 1000, 100);
    expect(result.calibratedRatio).toBe(5); // 500 chars / 100 tokens
  });

  it("falls back to estimated tokens when output_tokens is 0", () => {
    const state = createRateState(0);
    recordChars(state, 400); // 100 estimated tokens
    const result = finalizeRate(state, 1000, 0);
    expect(result.rate).toBe(100);
    // No calibration when provider tokens missing
    expect(result.calibratedRatio).toBe(DEFAULT_CHARS_PER_TOKEN);
  });

  it("returns null rate when elapsed is zero", () => {
    const state = createRateState(500);
    const result = finalizeRate(state, 500, 100);
    expect(result.rate).toBeNull();
  });
});

describe("formatRate", () => {
  it("formats small numbers as integers", () => {
    expect(formatRate(42)).toBe("42");
    expect(formatRate(99.7)).toBe("100");
  });

  it("formats large numbers with k suffix", () => {
    expect(formatRate(1500)).toBe("1.5k");
    expect(formatRate(10000)).toBe("10.0k");
  });

  it("shows dash for null", () => {
    expect(formatRate(null)).toBe("—");
  });
});
