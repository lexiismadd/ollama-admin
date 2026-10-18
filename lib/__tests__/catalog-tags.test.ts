import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseTagRows } from "../catalog";

const fixture = readFileSync("lib/__tests__/fixtures/tags-page.html", "utf8");

describe("parseTagRows", () => {
  const rows = parseTagRows(fixture);
  const byTag = new Map(rows.map((r) => [r.tag, r]));

  it("produces one granular row per variant (mobile/desktop blocks deduped)", () => {
    expect(rows).toHaveLength(4);
    expect([...byTag.keys()].sort()).toEqual(["cloud", "e2b-mlx", "e2b-mlx-bf16", "latest"]);
  });

  it("parses size ranges as the max bytes with the raw label kept", () => {
    const latest = byTag.get("latest")!;
    expect(latest.sizeLabel).toBe("6.6GB - 9.5GB");
    expect(latest.sizeBytes).toBe(9.5 * 1024 ** 3);
  });

  it("parses single-variant sizes in bytes", () => {
    expect(byTag.get("e2b-mlx")!.sizeBytes).toBe(7.5 * 1024 ** 3);
    expect(byTag.get("e2b-mlx-bf16")!.sizeBytes).toBe(10 * 1024 ** 3);
  });

  it("parses the context length per variant", () => {
    expect(byTag.get("latest")!.contextLength).toBe(131072);
    expect(byTag.get("cloud")!.contextLength).toBe(262144);
  });

  it("flags MLX variants", () => {
    expect(byTag.get("e2b-mlx")!.isMLX).toBe(true);
    expect(byTag.get("e2b-mlx-bf16")!.isMLX).toBe(true);
    expect(byTag.get("latest")!.isMLX).toBe(false);
  });

  it("extracts capabilities and relative update time per variant", () => {
    const mlx = byTag.get("e2b-mlx")!;
    expect(mlx.capabilities).toContain("text");
    expect(mlx.capabilities).toContain("vision");
    expect(mlx.updated).toBe("1 month ago");
  });
});
