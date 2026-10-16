export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { clearCatalogCache, isCatalogCacheStale, scrapeAllModels } from "@/lib/catalog";

// POST /api/catalog/seed — force-refresh the scraped model catalog.
// Documented in README.md; admin-only like the other admin APIs.
export async function POST() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    clearCatalogCache();
    const models = await scrapeAllModels(true);
    return NextResponse.json({
      count: models.length,
      timestamp: Date.now(),
      stale: isCatalogCacheStale(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh catalog";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
