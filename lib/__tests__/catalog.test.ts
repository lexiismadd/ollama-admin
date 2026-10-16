import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    catalogModel: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

describe("fetchCloudEntries", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OLLAMA_API_KEY;
    vi.unstubAllGlobals();
  });

  it("builds enriched entries from /api/tags + /api/show", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "gemma4:31b-cloud",
                model: "gemma4:31b-cloud",
                modified_at: new Date(Date.now() - 3600_000).toISOString(),
                size: 65_000_000_000,
                capabilities: ["completion", "tools"],
              },
              {
                name: "test-embed",
                model: "test-embed",
                size: 100_000_000,
                capabilities: ["embedding"],
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/api/show")) {
        const body = JSON.parse(String(init?.body));
        if (body.model === "gemma4:31b-cloud") {
          return new Response(
            JSON.stringify({
              capabilities: ["completion", "thinking", "tools", "vision"],
              details: {
                parent_model: "gemma4:31b-cloud",
                family: "gemma4",
                parameter_size: "32682372656",
                quantization_level: "BF16",
              },
              model_info: { "gemma4.context_length": 262144 },
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ error: "model not found" }), { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchCloudEntries } = await import("../catalog");
    const entries = await fetchCloudEntries();

    expect(entries).toHaveLength(2);

    const gemma = entries.find((e) => e.id === "gemma4:31b-cloud");
    expect(gemma).toMatchObject({
      name: "gemma4:31b-cloud",
      capabilities: ["text", "thinking", "tools", "vision"],
      family: "gemma4",
      parentModel: null,
      parameterSize: "32.7B",
      quantizationLevel: "BF16",
      contextLength: 262144,
      sizeBytes: 65_000_000_000,
      url: "https://ollama.com/library/gemma4",
      sizes: ["31b-cloud"],
    });
    expect(gemma?.updated).toBe("1 hour ago");

    // /api/show failure degrades to tags data
    const embed = entries.find((e) => e.id === "test-embed");
    expect(embed).toMatchObject({
      capabilities: ["embedding"],
      parameterSize: null,
      contextLength: null,
      sizes: ["latest"],
    });

    const showCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/show"));
    expect(showCalls).toHaveLength(2);
  });
});
