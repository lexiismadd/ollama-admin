export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { getCatalog } from "@/lib/catalog";

// POST /api/catalog/seed — force-refresh the catalog (Ollama.com cloud API when
// OLLAMA_API_KEY is set, ollama.com scrape otherwise). Admin-only.
export async function POST() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { entries, stale, source } = await getCatalog(true);
    return NextResponse.json({
      count: entries.length,
      timestamp: Date.now(),
      stale,
      source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh catalog";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
