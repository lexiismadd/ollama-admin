import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const upsertMock = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    huggingFaceModel: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: upsertMock,
    },
  },
}));

describe("hfModelToEntry enrichment", () => {
  beforeEach(() => {
    process.env.HUGGINGFACE_API_KEY = "test-key";
    upsertMock.mockReset();
  });

  afterEach(() => {
    delete process.env.HUGGINGFACE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("enriches params, quant, context and size from the HF detail endpoints", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/models/user/repo/tree/main")) {
        return new Response(
          JSON.stringify([
            { type: "file", path: "model-00001-of-00002.safetensors", lfs: { size: 5_000_000_000 } },
            { type: "file", path: "model-00002-of-00002.safetensors", lfs: { size: 3_000_000_000 } },
            { type: "file", path: "config.json", size: 1024 },
          ]),
          { status: 200 }
        );
      }
      if (url.includes("/safetensors-metadata/model.safetensors.index.json")) {
        return new Response(
          JSON.stringify({ index: { metadata: { total_parameters: 32_682_372_656 } } }),
          { status: 200 }
        );
      }
      if (url.includes("/resolve/main/config.json")) {
        return new Response(
          JSON.stringify({ model_type: "llama", text_config: { max_position_embeddings: 262144 } }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    }));

    const { hfModelToEntry } = await import("../huggingface-server");
    const entry = await hfModelToEntry({
      id: "user/repo",
      downloads: 1000,
      lastModified: new Date(Date.now() - 3_600_000).toISOString(),
      library_name: "transformers",
      pipeline_tag: "text-generation",
      tags: [],
      siblings: [
        { rfilename: "model.safetensors.index.json" },
        { rfilename: "model-00001-of-00002.safetensors" },
      ],
    });

    expect(entry.parameterSize).toBe("32.7B");
    expect(entry.contextLength).toBe(262144);
    expect(entry.sizeBytes).toBe(8_000_000_000);
    expect(entry.sizeLabel).toBe("7.5 GB");
    expect(entry.name).toBe("user/repo");
    expect(entry.isMLX).toBe(false);

    // cache write attempted with the enriched values
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const args = upsertMock.mock.calls[0][0] as { create: Record<string, unknown> };
    expect(args.create.parameterSize).toBe("32.7B");
    expect(args.create.contextLength).toBe(262144);
  });

  it("serves cached details without network calls when the row is fresh", async () => {
    const findUniqueMock = vi.fn().mockResolvedValue({
      id: "user/cached",
      family: "test",
      parentModel: null,
      parameterSize: "8.0B",
      quantizationLevel: "Q4_K_M",
      contextLength: 4096,
      sizeBytes: BigInt(4_000_000_000),
      sizeLabel: "3.7 GB",
      capabilities: "text",
      pulls: "10",
      updated: "1 day ago",
      cachedAt: new Date(),
    });
    const mod = await import("@/lib/prisma");
    (mod.prisma.huggingFaceModel.findUnique as unknown as ReturnType<typeof vi.fn>).mockImplementation(findUniqueMock);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { hfModelToEntry } = await import("../huggingface-server");
    const entry = await hfModelToEntry({ id: "user/cached", downloads: 10 });

    expect(entry.parameterSize).toBe("8.0B");
    expect(entry.quantizationLevel).toBe("Q4_K_M");
    expect(entry.contextLength).toBe(4096);
    expect(entry.sizeBytes).toBe(4_000_000_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });
});