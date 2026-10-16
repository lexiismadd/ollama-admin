export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { catalogCache, isCatalogCacheStale, scrapeAllModels } from "@/lib/catalog";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const capabilities = req.nextUrl.searchParams.get("c")?.toLowerCase() || "";
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const capList = capabilities
    ? capabilities.split(",").filter(Boolean)
    : [];

  try {
    let models = await scrapeAllModels(refresh);

    if (search) {
      models = models.filter(
        (m) =>
          m.name.toLowerCase().includes(search) ||
          m.description.toLowerCase().includes(search)
      );
    }

    if (capList.length > 0) {
      models = models.filter((m) =>
        capList.every((c) => m.capabilities.includes(c))
      );
    }

    // Serve-stale signal: if the cache predates the TTL, the last scrape
    // failed and the client is seeing older data.
    const headers: Record<string, string> = {};
    if (catalogCache && isCatalogCacheStale()) headers["X-Catalog-Stale"] = "true";
    return NextResponse.json(models, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch models from ollama.com" },
      { status: 502 }
    );
  }
}
