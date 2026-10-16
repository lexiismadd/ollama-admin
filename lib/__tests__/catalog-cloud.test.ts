import { describe, it, expect } from "vitest";
import {
  extractContextLength,
  formatParameterSize,
  formatRelativeTime,
  mapApiCapabilities,
  catalogPageUrl,
} from "../catalog-cloud";

describe("mapApiCapabilities", () => {
  it("maps completion to text", () => {
    expect(mapApiCapabilities(["completion", "thinking", "tools"])).toEqual(["text", "thinking", "tools"]);
  });

  it("keeps unknown capabilities as-is", () => {
    expect(mapApiCapabilities(["decision", "vision"])).toEqual(["decision", "vision"]);
  });

  it("returns empty for undefined", () => {
    expect(mapApiCapabilities(undefined)).toEqual([]);
  });
});

describe("formatParameterSize", () => {
  it("formats raw parameter counts", () => {
    expect(formatParameterSize("32682372656")).toBe("32.7B");
    expect(formatParameterSize("7000000000")).toBe("7.0B");
    expect(formatParameterSize("1500000")).toBe("1.5B");
  });

  it("passes through label-style values", () => {
    expect(formatParameterSize("8.0B")).toBe("8.0B");
    expect(formatParameterSize("Q4_K_M")).toBe("Q4_K_M");
  });

  it("returns null for missing values", () => {
    expect(formatParameterSize(undefined)).toBeNull();
    expect(formatParameterSize("")).toBeNull();
  });
});

describe("extractContextLength", () => {
  it("reads the family-prefixed key", () => {
    expect(extractContextLength({ "gemma4.context_length": 262144, "general.architecture": "gemma4" })).toBe(262144);
  });

  it("falls back to a bare context_length key", () => {
    expect(extractContextLength({ context_length: 4096 })).toBe(4096);
  });

  it("returns null when absent", () => {
    expect(extractContextLength({ "general.architecture": "llama" })).toBeNull();
    expect(extractContextLength(undefined)).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  it("formats a recent timestamp", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe("2 hours ago");
  });

  it("returns empty for missing or invalid input", () => {
    expect(formatRelativeTime(undefined)).toBe("");
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});

describe("catalogPageUrl", () => {
  it("strips the tag", () => {
    expect(catalogPageUrl("gemma4:31b-cloud")).toBe("https://ollama.com/library/gemma4");
    expect(catalogPageUrl("llama3")).toBe("https://ollama.com/library/llama3");
  });

  it("returns null for empty names", () => {
    expect(catalogPageUrl(":8b")).toBeNull();
  });
});
